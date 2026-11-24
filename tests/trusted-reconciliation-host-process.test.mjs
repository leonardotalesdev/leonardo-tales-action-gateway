import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { lstat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createTrustedReconciliationHost } from '../dist/index.js'
import { computeSnapshotChecksum as digest } from '../dist/internal/digest.js'
import { first, persistedFiles, projectDirectory, second, time, workspace } from './fixture.mjs'
import { decisionRows, installInterruptedPrefix, journal, promotedAmbiguous, startNative } from './reconciliation-decision-fixture.mjs'

const worker = new URL('./trusted-reconciliation-host-worker.mjs', import.meta.url)
const request = {
  requestId: 'recovery-request-' + first.operationKey,
  operationKey: first.operationKey,
  evidenceRef: { id: 'qualified-evidence-' + first.operationKey, revision: 1 },
}

async function startWorker(t, directory, options = {}) {
  const child = fork(worker, [directory, JSON.stringify({ request, ...options })], {
    execArgv: [], stdio: ['pipe', 'ignore', 'inherit', 'ipc'],
  })
  const exit = once(child, 'exit')
  const stopped = () => child.exitCode !== null || child.signalCode !== null
  t.after(async () => {
    if (!stopped()) child.kill('SIGKILL')
    await exit
  })
  async function next(type, action) {
    const message = once(child, 'message', { signal: AbortSignal.timeout(6000) })
    action?.()
    const [result] = await message
    assert.equal(result.type, type)
    return result
  }
  await next('ready')
  return {
    async assess() { await next('assessed', () => child.send('start')) },
    async startWithoutAssessment() { return receipt(next('receipt', () => child.send('start'))) },
    async resolve() { return receipt(next('receipt', () => child.send('resolve'))) },
    async pauseAfterAudit() { await next('after-audit', () => child.send('resolve')) },
    async continueAfterAudit() { return receipt(next('receipt', () => child.stdin.write(Buffer.from([1])))) },
    async loseAcknowledgement() { await next('durable-without-acknowledgement', () => child.send('resolve')) },
    async kill() {
      assert.equal(child.kill('SIGKILL'), true)
      assert.deepEqual(await exit, [null, 'SIGKILL'])
    },
  }
  async function receipt(message) {
    const { type, ...result } = await message
    assert.deepEqual(await exit, [0, null])
    return result
  }
}

async function qualifications(root) {
  return (await journal(root)).filter(({ event }) => event.type === 'reconciliation-decision-qualified')
}

function expectedFinal(status, outcome = 'reconciled-effect') {
  return { status, ...request, outcome }
}

async function verifyDecision(root, revision, eventCount) {
  const rows = await decisionRows(root)
  assert.equal(rows.length, revision === 0 ? 0 : 1)
  if (revision) {
    assert.equal(rows[0].envelope.record.revision, revision)
    assert.equal(rows[0].envelope.record.payload.phase, revision === 1 ? 'qualified' : 'applied')
  }
  assert.equal((await qualifications(root)).length, eventCount)
}

const otherRequest = { ...request, requestId: 'another-reconciliation' }
const otherOperation = { ...request, operationKey: second.operationKey }
const races = [
  ['exact qualification', {}, expectedFinal('replayed')],
  ['opposing assessment for same request', { outcome: 'confirmed-no-effect' }, { status: 'refused', code: 'request-conflict' }],
  ['different request IDs for same attempt', { request: otherRequest }, { status: 'refused', code: 'attempt-conflict' }],
  ['same request ID for different operations', { request: otherOperation }, { status: 'refused', code: 'request-conflict' }],
]

for (const [label, rival, expected] of races) {
  test(`R4 overlapping processes preserve one decision for ${label}`, { timeout: 15_000 }, async (t) => {
    const { root, gateway, calls } = await promotedAmbiguous(t)
    const separateOperation = rival.request?.operationKey === second.operationKey
    if (separateOperation) assert.equal((await gateway.execute(second)).decision, 'UNKNOWN')
    const left = await startWorker(t, root)
    const right = await startWorker(t, root, rival)
    // Both processes finish external assessment before either installs a decision.
    // Release the winner first so the contender reaches R3 rather than writer contention.
    await left.assess()
    await right.assess()
    await verifyDecision(root, 0, 0)
    assert.deepEqual(await left.resolve(), { receipt: expectedFinal('applied'), resolverCalls: 1, clockCalls: 2 })
    const installed = await persistedFiles(root)
    assert.deepEqual(await right.resolve(), { receipt: expected, resolverCalls: 1, clockCalls: 0 })
    assert.deepEqual(await persistedFiles(root), installed)
    await verifyDecision(root, 2, 1)
    assert.equal((await gateway.inspect(first.operationKey)).reason, 'reconciled-effect')
    if (separateOperation) assert.equal((await gateway.inspect(second.operationKey)).decision, 'UNKNOWN')
    assert.equal(calls.handler, separateOperation ? 2 : 1)
  })
}

test('two controllers in one process also distinguish the applying caller from an in-flight replay', async (t) => {
  const { root, options, calls } = await promotedAmbiguous(t)
  function controller(entered, release) {
    return createTrustedReconciliationHost({ directory: root, taskId: options.task.id, host: {
      actorId: 'trusted-resolver', now: () => time,
      async resolveEvidence({ requestId, actorId, evidenceRef, subject }) {
        entered.resolve()
        await release.promise
        return {
          status: 'confirmed-effect', qualifiedAt: time, evidenceDigest: digest('same-evidence'),
          effectOccurredDigest: digest('same-effect'),
          binding: { requestId, actorId, evidenceRef, subjectDigest: subject.subjectDigest, expectedState: subject.expectedState },
        }
      },
    } })
  }
  const leftEntered = Promise.withResolvers()
  const rightEntered = Promise.withResolvers()
  const leftRelease = Promise.withResolvers()
  const rightRelease = Promise.withResolvers()
  const left = await controller(leftEntered, leftRelease)
  const right = await controller(rightEntered, rightRelease)
  const leftResult = left.reconcile(request)
  let rightResult
  try {
    await Promise.race([leftEntered.promise, leftResult.then(assert.fail)])
    rightResult = right.reconcile(request)
    await Promise.race([rightEntered.promise, rightResult.then(assert.fail)])
    leftRelease.resolve()
    assert.deepEqual(await leftResult, expectedFinal('applied'))
    rightRelease.resolve()
    assert.deepEqual(await rightResult, expectedFinal('replayed'))
    await verifyDecision(root, 2, 1)
    assert.equal(calls.handler, 1)
  } finally {
    leftRelease.resolve()
    rightRelease.resolve()
    await Promise.allSettled([leftResult, rightResult])
  }
})

for (const assessmentCompleted of [false, true]) {
  const boundary = assessmentCompleted ? 'after external assessment, before issuance' : 'before resolver execution'
  test(`R4 process death ${boundary} leaves no decision and can start fresh`, { timeout: 15_000 }, async (t) => {
    const { root, calls } = await promotedAmbiguous(t)
    const before = await persistedFiles(root)
    const worker = await startWorker(t, root)
    if (assessmentCompleted) await worker.assess()
    await worker.kill()
    assert.deepEqual(await persistedFiles(root), before)
    await verifyDecision(root, 0, 0)
    const restarted = await startWorker(t, root)
    await restarted.assess()
    assert.deepEqual(await restarted.resolve(), { receipt: expectedFinal('applied'), resolverCalls: 1, clockCalls: 2 })
    await verifyDecision(root, 2, 1)
    assert.equal(calls.handler, 1)
  })
}

test('R4 replays a durable applied decision after a separate process loses its acknowledgement', { timeout: 15_000 }, async (t) => {
  const { root, calls } = await promotedAmbiguous(t)
  const firstWorker = await startWorker(t, root, { loseAcknowledgement: true })
  await firstWorker.assess()
  await firstWorker.loseAcknowledgement()
  await verifyDecision(root, 2, 1)
  const applied = await persistedFiles(root)
  await firstWorker.kill()

  const restarted = await startWorker(t, root)
  assert.deepEqual(await restarted.startWithoutAssessment(), { receipt: expectedFinal('replayed'), resolverCalls: 0, clockCalls: 0 })
  assert.deepEqual(await persistedFiles(root), applied)
  assert.equal(calls.handler, 1)
})

test('R4 restart after revision 1 before the qualification event requires exact re-attestation', { timeout: 15_000 }, async (t) => {
  const { root, gateway, calls } = await promotedAmbiguous(t)
  const beforeEvent = await startWorker(t, root)
  await beforeEvent.assess()
  const auditLock = join(await projectDirectory(root, 'audit'), '.writer.lock')
  await writeFile(auditLock, 'R4 test owns the audit writer', { flag: 'wx', mode: 0o600 })
  try {
    assert.deepEqual(await beforeEvent.resolve(), {
      receipt: { status: 'refused', code: 'store-busy' }, resolverCalls: 1, clockCalls: 1,
    })
    await verifyDecision(root, 1, 0)
    assert.partialDeepStrictEqual(await gateway.inspect(first.operationKey), { decision: 'UNKNOWN', held: 4 })
  } finally {
    await unlink(auditLock)
  }

  const pending = await persistedFiles(root)
  const otherActor = await startWorker(t, root, { actorId: 'different-actor' })
  assert.deepEqual(await otherActor.startWithoutAssessment(), {
    receipt: { status: 'refused', code: 'request-conflict' }, resolverCalls: 0, clockCalls: 0,
  })
  const otherEffect = await startWorker(t, root, { changes: { effectOccurredDigest: digest('changed-effect') } })
  await otherEffect.assess()
  assert.deepEqual(await otherEffect.resolve(), {
    receipt: { status: 'refused', code: 'request-conflict' }, resolverCalls: 1, clockCalls: 0,
  })
  assert.deepEqual(await persistedFiles(root), pending)

  const restarted = await startWorker(t, root)
  await restarted.assess()
  assert.deepEqual(await restarted.resolve(), { receipt: expectedFinal('applied'), resolverCalls: 1, clockCalls: 2 })
  await verifyDecision(root, 2, 1)
  assert.equal(calls.handler, 1)
})

test('R4 restart after revision 1 and audit rejects changed attestation and resumes the exact no-effect decision', { timeout: 20_000 }, async (t) => {
  const { root, gateway, calls } = await promotedAmbiguous(t)
  const outcome = 'confirmed-no-effect'
  const interrupted = await startWorker(t, root, { outcome, pauseAfterAudit: true })
  await interrupted.assess()
  await interrupted.pauseAfterAudit()
  await verifyDecision(root, 1, 1)
  await interrupted.kill()
  const stateLock = join(await projectDirectory(root, 'state'), '.writer.lock')
  assert.equal((await lstat(stateLock)).mode & 0o777, 0o600)
  await assert.rejects(gateway.inspect(first.operationKey), { code: 'locked' })
  // These isolated fixtures are owned by the test. The dead process cannot still own this lock.
  await unlink(stateLock)
  assert.partialDeepStrictEqual(await gateway.inspect(first.operationKey), { decision: 'UNKNOWN', held: 4 })

  const pending = await persistedFiles(root)
  const alternatives = [
    { outcome: 'confirmed-effect' },
    { outcome, changes: { qualifiedAt: '2030-01-01T00:00:00.001Z' } },
    { outcome, changes: { evidenceDigest: digest('changed-evidence') } },
    { outcome, changes: { effectAbsentDigest: digest('changed-absence') } },
    { outcome, changes: { attemptFinalityDigest: digest('changed-finality') } },
  ]
  for (const alternative of alternatives) {
    const changed = await startWorker(t, root, alternative)
    await changed.assess()
    assert.deepEqual(await changed.resolve(), {
      receipt: { status: 'refused', code: 'request-conflict' }, resolverCalls: 1, clockCalls: 0,
    })
  }
  assert.deepEqual(await persistedFiles(root), pending)
  const restarted = await startWorker(t, root, { outcome })
  await restarted.assess()
  assert.deepEqual(await restarted.resolve(), {
    receipt: expectedFinal('applied', 'reconciled-no-effect'), resolverCalls: 1, clockCalls: 2,
  })
  await verifyDecision(root, 2, 1)
  assert.partialDeepStrictEqual(await gateway.inspect(first.operationKey), { decision: 'BLOCKED', held: 0, remaining: 10 })
  assert.equal(calls.handler, 1)
})

test('R4 writer fences another controller and ordinary inspect and execute during application', { timeout: 15_000 }, async (t) => {
  const { root, gateway, calls } = await promotedAmbiguous(t)
  const applying = await startWorker(t, root, { pauseAfterAudit: true })
  const contender = await startWorker(t, root)
  await applying.assess()
  await applying.pauseAfterAudit()
  await verifyDecision(root, 1, 1)
  const during = await persistedFiles(root)
  assert.deepEqual(await contender.startWithoutAssessment(), {
    receipt: { status: 'refused', code: 'store-busy' }, resolverCalls: 0, clockCalls: 0,
  })
  await assert.rejects(gateway.inspect(first.operationKey), { code: 'locked' })
  await assert.rejects(gateway.execute(first), { code: 'locked' })
  await assert.rejects(gateway.execute(second), { code: 'locked' })
  assert.deepEqual(await persistedFiles(root), during)
  assert.equal(calls.handler, 1)
  assert.deepEqual(await applying.continueAfterAudit(), {
    receipt: expectedFinal('applied'), resolverCalls: 1, clockCalls: 2,
  })
  assert.partialDeepStrictEqual(await gateway.execute(first), { reason: 'reconciled-effect', replayed: true })
  assert.equal(calls.handler, 1)
  await verifyDecision(root, 2, 1)
})

const lateOutcomes = [
  ['success', { status: 'confirmed-success', evidenceRef: { id: 'late-effect', revision: 1 } }],
  ['failure', { status: 'confirmed-failure', effect: 'not-performed', evidenceRef: { id: 'late-absence', revision: 1 } }],
  ['unknown', { status: 'unknown' }],
  ['exception', new Error('late handler failure')],
]

for (const [label, result] of lateOutcomes) {
  test(`R4 qualification fences late native ${label} across processes`, { timeout: 15_000 }, async (t) => {
    const root = await workspace(t)
    const entered = Promise.withResolvers()
    const continuation = Promise.withResolvers()
    const history = await startNative(root, entered, continuation)
    const { native, proposalId, gateway } = history
    const execution = native.execute(proposalId)
    try {
      await Promise.race([entered.promise, execution.then((receipt) => assert.fail(JSON.stringify(receipt)))])
      await installInterruptedPrefix(history)
      const qualifying = await startWorker(t, root, { failAfterAudit: true })
      await qualifying.assess()
      assert.deepEqual(await qualifying.resolve(), {
        receipt: { status: 'refused', code: 'invalid-clock' }, resolverCalls: 1, clockCalls: 2,
      })
      await verifyDecision(root, 1, 1)
      const pending = await persistedFiles(root)

      if (result instanceof Error) continuation.reject(result)
      else continuation.resolve(result)
      assert.deepEqual(await execution, {
        status: 'execution_unknown', code: 'reconciliation-required', executionId: history.binding.executionId,
      })
      assert.equal(history.decisionReads(), 2)
      assert.deepEqual(await persistedFiles(root), pending)

      const applying = await startWorker(t, root)
      await applying.assess()
      assert.deepEqual(await applying.resolve(), { receipt: expectedFinal('applied'), resolverCalls: 1, clockCalls: 2 })
      await verifyDecision(root, 2, 1)
      assert.partialDeepStrictEqual(await gateway.execute(first), { reason: 'reconciled-effect', replayed: true })
      assert.equal(history.invocations(), 1)
    } finally {
      continuation.resolve({ status: 'unknown' })
      await execution
    }
  })
}
