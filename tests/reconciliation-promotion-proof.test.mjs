import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createActionGateway } from '../dist/index.js'
import { config, first, legacyIntent, persistedFiles, records, second } from './fixture.mjs'
import { makeQualification, readSubject } from './reconciliation-decision-fixture.mjs'
import {
  allowance, assertDecision, assertEntries, assertOnlyDecisionAndEventChanged, prepareAmbiguous, proofConfig, proofRequest, proofScope,
} from './reconciliation-process-proof-fixture.mjs'

const exec = promisify(execFile)
const promoteCli = fileURLToPath(new URL('../dist/cli/promote-r2.js', import.meta.url))
const crashWorker = fileURLToPath(new URL('./worker.mjs', import.meta.url))
const historicalLocale = 'sv-SE'
const ambientLocales = [
  { value: 'sv_SE.UTF-8', measured: 'sv-SE' },
  { value: 'en_US.UTF-8', measured: 'en-US' },
]
const offlineCommandOptions = { timeout: 8_000, killSignal: 'SIGKILL', env: { ...process.env, NODE_OPTIONS: '' } }

async function promoteOffline(root, legacyDigestLocale) {
  const localeArgs = legacyDigestLocale ? ['--legacy-digest-locale', legacyDigestLocale] : []
  const { stdout, stderr } = await exec(process.execPath, [
    promoteCli, '--directory', root, '--task-id', config(root).task.id, ...localeArgs,
  ], offlineCommandOptions)
  assert.equal(stderr, '')
  assert.match(stdout, /^[0-9a-f]{64}\n$/)
  return stdout.trim()
}

function requestFor({ requestId, operationKey, evidenceRef }) {
  return { requestId, operationKey, evidenceRef }
}

async function startAssessment(scope, options, locale) {
  const worker = await scope.start({ ...options, ambient: locale.value })
  assert.equal(worker.ready.ambientLocale, locale.measured)
  worker.send({ type: 'start' })
  const { context, assessment } = await worker.next('assessed')
  return { worker, context, assessment }
}

async function assertColdRefusal(scope, options, code) {
  const worker = await scope.start({ ...options, failResolver: true, failClock: true })
  if (!worker.openingReceipt) worker.send({ type: 'start' })
  const result = worker.openingReceipt ?? await worker.result()
  assert.deepEqual(result.receipt, { status: 'refused', code })
  assert.equal(result.resolverCalls, 0)
  assert.equal(result.clockCalls, 0)
  assert.deepEqual(result.installs, [])
}

async function assertLocaleConsistentApply(scope, fixture, options, expected) {
  const { root } = scope
  const { gateway, subject, qualification, generation, intent } = fixture
  const { operationKey, digestVersion, amount, attemptId } = subject.subject
  const request = requestFor(qualification)
  const before = await persistedFiles(root)
  const previous = [amount, expected.previousSettlement, config(root).task.cap - amount - expected.previousSettlement]
  const settled = [0, previous[1] + amount, previous[2]]
  assert.deepEqual(await allowance(gateway, operationKey), previous)
  assert.deepEqual(previous, expected.before)
  await assertDecision(root, { revision: 0, eventCount: 0 })

  const [swedish, american] = ambientLocales
  const left = await startAssessment(scope, { ...options, request }, swedish)
  const right = await startAssessment(scope, { ...options, request }, american)
  assert.notEqual(left.worker.pid, right.worker.pid)
  assert.notEqual(left.worker.ready.ambientLocale, right.worker.ready.ambientLocale)
  assert.deepEqual(left.context, right.context)
  assert.deepEqual(left.assessment, right.assessment)
  assert.partialDeepStrictEqual(left.context.subject, {
    operationKey, digestVersion, amount, attemptId, storeGeneration: generation,
    subjectDigest: subject.subjectDigest, expectedState: subject.expectedState,
    observedPrefix: 'reconciliation-required',
  })
  assert.deepEqual(await persistedFiles(root), before)
  left.worker.send({ type: 'release', epoch: 1 })
  const applied = await left.worker.result()
  assert.deepEqual(applied.receipt, { status: 'applied', ...request, outcome: 'reconciled-effect' })
  assert.equal(applied.resolverCalls, 1)
  await assertDecision(root, { revision: 2, qualification, eventCount: 1 })
  assert.deepEqual(await allowance(gateway, operationKey), settled)
  assert.deepEqual(settled, expected.after)
  const durable = await persistedFiles(root)
  await assertOnlyDecisionAndEventChanged(root, before, durable)

  const replayReceipt = { status: 'replayed', ...request, outcome: 'reconciled-effect' }
  right.worker.send({ type: 'release', epoch: 1 })
  const inFlight = await right.worker.result()
  assert.deepEqual(inFlight.receipt, replayReceipt)
  assert.equal(inFlight.resolverCalls, 1)
  assert.equal(inFlight.clockCalls, 0)
  assert.deepEqual(inFlight.installs, [])
  const restart = await scope.start({
    ...options, request, ambient: american.value, failResolver: true, failClock: true,
  })
  assert.equal(restart.ready.ambientLocale, american.measured)
  restart.send({ type: 'start' })
  const replay = await restart.result()
  assert.deepEqual(replay.receipt, replayReceipt)
  assert.equal(replay.resolverCalls, 0)
  assert.equal(replay.clockCalls, 0)
  assert.deepEqual(replay.installs, [])
  assert.partialDeepStrictEqual(await gateway.execute(intent), {
    decision: 'EXECUTED', reason: 'reconciled-effect', replayed: true,
  })
  assert.deepEqual(await allowance(gateway, operationKey), settled)
  assert.deepEqual(await persistedFiles(root), durable)
}

test('R5 offline promotion of a crashed reserved attempt keeps public reconciliation ineligible', { timeout: 30_000 }, async (t) => {
  const scope = await proofScope(t)
  const { root } = scope
  try {
    // The existing worker syncs the only original handler entry, then exits from inside that handler.
    await assert.rejects(exec(process.execPath, [crashWorker, root, 'crash'], offlineCommandOptions), {
      code: 77, signal: null, stderr: '',
    })
    const handlerEntries = join(root, 'effects')
    assert.equal(await readFile(handlerEntries, 'utf8'), '4\n')

    const options = config(root)
    const standardHandler = options.tool.execute
    options.tool.execute = async (input) => {
      await standardHandler(input)
      assert.fail('reserved handler ran after worker exit')
    }
    const gateway = await createActionGateway(options)
    const reserved = await readSubject(root)
    assert.equal(reserved.observedPrefix, 'reserved')
    assert.deepEqual(await allowance(gateway), [4, 0, 6])
    const unpromoted = await persistedFiles(root)
    const generation = await promoteOffline(root)
    const promoted = await persistedFiles(root)
    assert.deepEqual(Object.keys(promoted).sort(), Object.keys(unpromoted).sort())
    const changedPaths = Object.keys(unpromoted).filter((path) => !unpromoted[path].equals(promoted[path]))
    const [manifest] = (await records(root, 'action-allowance')).filter(({ envelope }) => envelope.record.id === 'task-allowance')
    assert.deepEqual(changedPaths, [relative(root, manifest.path)])
    assert.equal(manifest.envelope.record.revision, 2)
    assert.equal(manifest.envelope.record.payload.storeGeneration, generation)
    const subject = await readSubject(root)
    assert.equal(subject.observedPrefix, 'reserved')
    assert.equal(subject.subjectDigest, reserved.subjectDigest)
    assert.notEqual(subject.expectedState, reserved.expectedState)

    await assertColdRefusal(scope, { request: proofRequest }, 'ineligible')
    await assertDecision(root, { revision: 0, eventCount: 0 })
    assert.deepEqual(await allowance(gateway), [4, 0, 6])
    assert.partialDeepStrictEqual(await gateway.execute(first), { decision: 'UNKNOWN', replayed: true })
    assert.equal(await readFile(handlerEntries, 'utf8'), '4\n')
    assert.deepEqual(await persistedFiles(root), promoted)
  } finally {
    await scope.close()
  }
})

test('R5 deterministic promoted history preserves bindings across distinct effective process locales', { timeout: 45_000 }, async (t) => {
  const scope = await proofScope(t)
  try {
    const fixture = await prepareAmbiguous(scope)
    assert.equal(fixture.subject.subject.digestVersion, 'utf16-v1')
    await assertLocaleConsistentApply(scope, { ...fixture, intent: first }, {}, {
      previousSettlement: 0, before: [4, 0, 6], after: [0, 4, 6],
    })
    await assertEntries(scope, [first])
  } finally {
    await scope.close()
  }
})

test('R5 promoted Swedish legacy history uses a discriminating explicit locale across fresh processes', { timeout: 45_000 }, async (t) => {
  const scope = await proofScope(t)
  const { root } = scope
  try {
    const stored = JSON.parse(await readFile(new URL('./fixtures/v0.1.0-sv-SE.json', import.meta.url), 'utf8'))
    assert.equal(stored.locale, historicalLocale)
    for (const [name, contents] of Object.entries(stored.files)) {
      const path = join(root, name)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, contents, { mode: 0o600 })
    }
    const gateway = await createActionGateway({ ...proofConfig(scope), legacyDigestLocale: historicalLocale })
    const intent = legacyIntent(second)
    assert.equal((await gateway.execute(intent)).decision, 'UNKNOWN')
    const generation = await promoteOffline(root, historicalLocale)
    const subject = await readSubject(root, second.operationKey, historicalLocale)
    assert.equal(subject.observedPrefix, 'reconciliation-required')
    assert.equal(subject.subject.digestVersion, 'legacy-v0.1')
    const qualification = makeQualification(subject, generation)
    const request = requestFor(qualification)
    const before = await persistedFiles(root)

    // A matching ambient locale cannot supply the missing setting or override a wrong explicit setting.
    const refusalOptions = { request, ambient: ambientLocales[0].value }
    await assertColdRefusal(scope, refusalOptions, 'legacy-locale-required')
    await assertColdRefusal(scope, { ...refusalOptions, legacyDigestLocale: 'en-US' }, 'corrupt-storage')
    assert.deepEqual(await persistedFiles(root), before)
    await assertDecision(root, { revision: 0, eventCount: 0 })

    const priorOperation = (await records(root, 'action-allowance')).find(({ envelope }) => envelope.record.payload.key === first.operationKey)
    const { binding, amount } = priorOperation.envelope.record.payload
    const priorAttempt = (await records(root, 'gateway-attempts')).find(({ envelope }) => envelope.record.id === binding.executionId)
    assert.equal(priorAttempt.envelope.record.payload.phase, 'closed')
    assert.equal(priorAttempt.envelope.record.payload.result.status, 'confirmed-success')
    await assertLocaleConsistentApply(scope, { gateway, subject, qualification, generation, intent }, {
      legacyDigestLocale: historicalLocale,
    }, { previousSettlement: amount, before: [3, 4, 3], after: [0, 7, 3] })
    // The checked-in release fixture already has a terminal first operation. Only second dispatches here.
    await assertEntries(scope, [second])
  } finally {
    await scope.close()
  }
})
