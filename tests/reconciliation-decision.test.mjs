import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { createActionGateway } from '../dist/index.js'
import { computeSnapshotChecksum as digest } from '../dist/internal/digest.js'
import { createExecutionAuditStore } from '../dist/internal/execution-audit.js'
import { encodeRecordEnvelope, openReconciliationStore } from '../dist/internal/local-store.js'
import { createReconciliationDecisionKernel } from '../dist/internal/reconciliation-decision.js'
import { promoteTaskStore } from '../dist/internal/store-promotion.js'
import { createTaskRunStore } from '../dist/internal/task-run-store.js'
import { transitionRun } from '../dist/internal/task-run.js'
import { config, first, inLocale, legacyIntent, persistedFiles, projectDirectory, records, second, third, time, workspace } from './fixture.mjs'
import { auditPath, decisionRows, journal, makeQualification, openHistory, openKernel, promotedAmbiguous, readSubject } from './reconciliation-decision-fixture.mjs'

const beforeTime = '2029-12-31T23:59:59.999Z'
const later = '2030-01-01T00:00:00.001Z'
const type = 'reconciliation-decision-qualified'
const acceptedR2 = 'df93b15c38a3aaf683e7115a3ac277c3fa01453b'

function apply(kernel, qualification) {
  return kernel.adjudicator.apply(kernel.issuer.issue(qualification))
}

async function qualificationEvents(root) {
  return (await journal(root)).filter(({ event }) => event.type === type)
}

async function writeEnvelope(path, envelope, record) {
  await writeFile(path, JSON.stringify(encodeRecordEnvelope(record, envelope.digestVersion)) + '\n')
}

async function assertOnlyDecisionAndAuditChanged(root, before) {
  const [row] = await decisionRows(root)
  const decisionFile = relative(root, row.path)
  const auditFile = relative(root, await auditPath(root))
  const after = await persistedFiles(root)
  assert.equal(before[decisionFile], undefined)
  assert.notDeepEqual(after[auditFile], before[auditFile])
  assert.deepEqual(after[auditFile].subarray(0, before[auditFile].length), before[auditFile])
  delete after[decisionFile]
  after[auditFile] = before[auditFile]
  assert.deepEqual(after, before)
}

test('R3 authority is an exact immutable qualification branded by the same kernel', async (t) => {
  const { root, qualification } = await promotedAmbiguous(t)
  const kernel = await openKernel(root)
  const other = await openKernel(root)
  const replica = await workspace(t)
  await cp(root, replica, { recursive: true })
  const paired = await openReconciliationStore(root, qualification.projectId)
  const copied = await openReconciliationStore(replica, qualification.projectId)
  assert.throws(() => createReconciliationDecisionKernel({
    store: { ...paired, audit: copied.audit }, now: () => time,
  }), { code: 'invalid-qualification' })
  const approved = structuredClone(qualification)
  const handle = kernel.issuer.issue(approved)
  approved.actorId = 'changed-after-issue'
  approved.proof.effectOccurredDigest = digest('changed-after-issue')
  const original = await persistedFiles(root)
  const stateLock = join(await projectDirectory(root, 'state'), '.writer.lock')
  await writeFile(stateLock, 'held writer', { flag: 'wx' })
  try {
    for (const bad of [{}, qualification, JSON.parse(JSON.stringify(handle)), other.issuer.issue(qualification)]) {
      await assert.rejects(kernel.adjudicator.apply(bad), { code: 'invalid-qualification' })
    }
  } finally {
    await unlink(stateLock)
  }
  const noEffect = makeQualification(await readSubject(root), qualification.storeGeneration, 'confirmed-no-effect')
  for (const bad of [
    { evidenceRef: qualification.evidenceRef },
    { ...noEffect, proof: { noEffect: true } },
    { ...noEffect, proof: { effectAbsentDigest: digest('absent') } },
    { ...qualification, evidenceRef: { id: 'invalid reference', revision: 1 } },
    { ...qualification, evidenceRef: { id: 'reference', revision: 0 } },
    { ...qualification, evidenceDigest: 'ABC' },
    { ...qualification, additional: 'untrusted field' },
    { ...qualification, qualifiedAt: '2030-01-01' },
    { ...qualification, outcome: 'unresolved' },
  ]) assert.throws(() => kernel.issuer.issue(bad), { code: 'invalid-qualification' })
  assert.deepEqual(await persistedFiles(root), original)
  const applied = await kernel.adjudicator.apply(handle)
  assert.ok(Object.isFrozen(applied))
  const [row] = await decisionRows(root)
  assert.equal(row.envelope.record.payload.qualification.actorId, qualification.actorId)
  assert.deepEqual(row.envelope.record.payload.qualification.proof, qualification.proof)
})

for (const outcome of ['confirmed-effect', 'confirmed-no-effect']) {
  test(`R3 ${outcome} accounts for one hold and retains native history and replay identity`, async (t) => {
    const { root, options, gateway, calls, qualification, generation, subject } = await promotedAmbiguous(t, outcome)
    const nativeRelease = { runId: 'run-native-release', operationKey: 'native-release', input: { rows: 2, batch: 'native-release' } }
    const outstanding = { ...third, input: { ...third.input, rows: 3 } }
    const refused = { runId: 'run-refused', operationKey: 'refused', input: { rows: 1, batch: 'refused' } }
    const fresh = { runId: 'run-fresh', operationKey: 'fresh', input: { rows: 4, batch: 'fresh' } }
    // Reopen with the same durable configuration to vary the outcomes of unrelated ordinary work.
    options.tool.execute = async (input) => {
      calls.handler++
      if (input.batch === 'native-release') return { outcome: 'no-effect', evidenceId: 'verified-native-no-effect' }
      if (input.batch === outstanding.input.batch) return { outcome: 'unknown' }
      return { outcome: 'executed', evidenceId: 'native-' + input.batch }
    }
    const current = await createActionGateway(options)
    assert.equal((await current.execute(second)).decision, 'EXECUTED')
    assert.equal((await current.execute(nativeRelease)).reason, 'confirmed-no-effect')
    assert.equal((await current.execute(outstanding)).decision, 'UNKNOWN')
    const refusal = await current.execute(refused)
    assert.partialDeepStrictEqual(refusal, { decision: 'BLOCKED', reason: 'task_limit',
      refusalBasis: { reason: 'task_limit', cap: 10, settled: 3, held: 7, remaining: 0, requested: 1 } })
    const held = await gateway.inspect(first.operationKey)
    assert.partialDeepStrictEqual(held, { decision: 'UNKNOWN', settled: 3, held: 7, remaining: 0 })
    assert.deepEqual(await readSubject(root), subject)
    const original = await persistedFiles(root)
    const callbacksBeforeApply = { ...calls }
    const kernel = await openKernel(root)
    const applied = await apply(kernel, qualification)

    const [row] = await decisionRows(root)
    const { record } = row.envelope
    const expectedId = 'reconciliation-' + digest(['action-gateway/reconciliation-decision/v1',
      qualification.projectId, qualification.taskId, qualification.operationKey, qualification.attemptId, qualification.executionIdentity])
    const expectedDigest = digest(['action-gateway/reconciliation-qualification/v1', qualification])
    const [{ event }] = await qualificationEvents(root)
    assert.equal(record.id, expectedId)
    assert.equal(row.envelope.schemaVersion, 'local-record-envelope/v0.2')
    assert.equal(row.envelope.digestVersion, 'utf16-v1')
    assert.equal(record.revision, 2)
    assert.deepEqual(record.payload, {
      schemaVersion: 'reconciliation-decision/v1', phase: 'applied', qualification,
      qualificationDigest: expectedDigest, runRevisionAtQualification: 5, appliedAt: time,
    })
    assert.deepEqual(event, {
      schemaVersion: 'execution-audit-event/v0.1',
      id: 'event-' + digest(['action-gateway/reconciliation-audit/v1', expectedId, 1, type]),
      projectId: qualification.projectId, taskId: qualification.taskId, runId: subject.subject.binding.runId,
      occurredAt: time, type, actorId: qualification.actorId, observationCode: outcome + ':' + expectedDigest,
      subjectRef: { kind: 'artifact', id: expectedId, revision: 1 },
    })
    assert.deepEqual(calls, callbacksBeforeApply)
    await assertOnlyDecisionAndAuditChanged(root, original)
    assert.deepEqual(await readSubject(root), subject)

    const effect = outcome === 'confirmed-effect'
    const appliedReceipt = { ...held, decision: effect ? 'EXECUTED' : 'BLOCKED',
      reason: effect ? 'reconciled-effect' : 'reconciled-no-effect', evidenceId: qualification.evidenceRef.id,
      settled: effect ? 7 : 3, held: 3, remaining: effect ? 0 : 4 }
    assert.deepEqual(await gateway.inspect(first.operationKey), appliedReceipt)
    assert.deepEqual(await current.execute({ ...first, runId: 'later' }), { ...appliedReceipt, replayed: true })
    assert.partialDeepStrictEqual(await current.execute({ ...first, input: { ...first.input, batch: 'changed' } }),
      { decision: 'CONFLICT', reason: 'operation-conflict' })
    assert.deepEqual(calls, { ...callbacksBeforeApply, measure: callbacksBeforeApply.measure + 1 })

    const bytes = await persistedFiles(root)
    assert.deepEqual(await apply(kernel, qualification), applied)
    const reopened = await openKernel(root, { now: () => assert.fail('applied replay sampled clock') })
    assert.deepEqual(await apply(reopened, qualification), applied)
    if (effect) {
      await assert.rejects(apply(reopened, {
        ...qualification, proof: { effectOccurredDigest: digest('another-effect-proof') },
      }), { code: 'request-conflict' })
    }
    for (const loser of [
      { ...qualification, requestId: 'same-outcome-other-request' },
      makeQualification(subject, generation, effect ? 'confirmed-no-effect' : 'confirmed-effect', { requestId: 'opposite-outcome' }),
    ]) {
      await assert.rejects(apply(reopened, loser), { code: 'attempt-conflict' })
    }
    const otherSubject = await readSubject(root, outstanding.operationKey)
    await assert.rejects(apply(reopened, makeQualification(otherSubject, generation, outcome, { requestId: qualification.requestId })),
      { code: 'request-conflict' })
    assert.deepEqual(await persistedFiles(root), bytes)

    if (!effect) {
      assert.partialDeepStrictEqual(await current.execute(fresh), { decision: 'EXECUTED', settled: 7, held: 3, remaining: 0 })
      assert.equal(calls.handler, callbacksBeforeApply.handler + 1)
      assert.deepEqual((await current.inspect(refused.operationKey)).refusalBasis, refusal.refusalBasis)
      assert.equal((await current.inspect(first.operationKey)).reason, 'reconciled-no-effect')
    }
    const after = await persistedFiles(root)
    assert.equal(await promoteTaskStore(root, options.task.id), generation)
    assert.deepEqual(await persistedFiles(root), after)
  })
}

test('revision one with a contended audit writer holds capacity and exact reissue after restart resumes', async (t) => {
  const { root, qualification, gateway } = await promotedAmbiguous(t, 'confirmed-no-effect')
  const lock = join(await projectDirectory(root, 'audit'), '.writer.lock')
  const startAudit = await journal(root)
  await writeFile(lock, 'contended audit writer', { flag: 'wx' })
  try {
    await assert.rejects(apply(await openKernel(root), qualification), { code: 'locked' })
    assert.deepEqual(await journal(root), startAudit)
    const [row] = await decisionRows(root)
    assert.equal(row.envelope.record.revision, 1)
    assert.equal(row.envelope.record.payload.appliedAt, null)
    assert.partialDeepStrictEqual(await gateway.inspect(first.operationKey), {
      decision: 'UNKNOWN', reason: 'reconciliation-required', evidenceId: null, held: 4, remaining: 6,
    })
  } finally {
    await unlink(lock)
  }
  const fresh = await openKernel(root)
  const original = await persistedFiles(root)
  const alternates = [
    { qualifiedAt: later },
    { actorId: 'another-resolver' },
    { evidenceDigest: digest('other-dossier') },
    { outcome: 'confirmed-effect', proof: { effectOccurredDigest: digest('effect') } },
    { proof: { ...qualification.proof, attemptFinalityDigest: digest('another-finality') } },
    { subjectDigest: digest('another-subject') },
    { expectedState: digest('another-state') },
    { attemptId: 'other-attempt' },
  ]
  for (const change of alternates) {
    await assert.rejects(apply(fresh, { ...qualification, ...change }), { code: 'request-conflict' }, JSON.stringify(change))
  }
  await assert.rejects(apply(fresh, { ...qualification, requestId: 'other-request' }), { code: 'attempt-conflict' })
  assert.deepEqual(await persistedFiles(root), original)
  await apply(fresh, qualification)
  assert.equal((await decisionRows(root))[0].envelope.record.revision, 2)
  assert.equal((await qualificationEvents(root)).length, 1)
  assert.partialDeepStrictEqual(await gateway.inspect(first.operationKey), { reason: 'reconciled-no-effect', held: 0, remaining: 10 })
})

test('promoted generation and subject tokens are matched before writing a decision', async (t) => {
  const { root, generation, qualification } = await promotedAmbiguous(t)
  const kernel = await openKernel(root)
  const before = await persistedFiles(root)
  for (const change of [
    { projectId: 'project-other' }, { taskId: 'task-other' }, { operationKey: 'different-operation' },
    { attemptId: 'execution-other' }, { executionIdentity: 'action-other' }, { subjectDigest: digest('unrelated-subject') },
    { expectedState: digest('stale-state') }, { storeGeneration: digest('other-generation') },
  ]) await assert.rejects(apply(kernel, { ...qualification, ...change }))
  assert.deepEqual(await persistedFiles(root), before)
  assert.equal((await decisionRows(root)).length, 0)

  const manifest = (await records(root, 'action-allowance')).find(({ envelope }) => envelope.record.id === 'task-allowance')
  assert.equal(manifest.envelope.record.payload.storeGeneration, generation)
  const { sourceManifest } = manifest.envelope.record.payload
  for (const payload of [
    { ...manifest.envelope.record.payload, storeGeneration: '0'.repeat(64) },
    { ...manifest.envelope.record.payload, sourceManifest: { ...sourceManifest, checksum: '0'.repeat(64) } },
  ]) {
    await writeEnvelope(manifest.path, manifest.envelope, { ...manifest.envelope.record, payload })
    const corrupt = await persistedFiles(root)
    await assert.rejects(apply(kernel, qualification))
    assert.deepEqual(await persistedFiles(root), corrupt)
  }
  await writeFile(manifest.path, JSON.stringify(sourceManifest) + '\n')
  const demoted = await persistedFiles(root)
  await assert.rejects(apply(kernel, qualification), { code: 'promotion-required' })
  assert.deepEqual(await persistedFiles(root), demoted)
  const historical = await readSubject(root)
  const newGeneration = await promoteTaskStore(root, config(root).task.id)
  const baseline = await persistedFiles(root)
  await assert.rejects(apply(kernel, makeQualification(historical, newGeneration)), { code: 'stale-state' })
  assert.deepEqual(await persistedFiles(root), baseline)
})

test('simultaneous exact or opposing callers never create a second decision or audit event', async (t) => {
  for (const opposing of [false, true]) {
    await t.test(opposing ? 'opposing qualifications' : 'same qualification', async (st) => {
      const { root, generation, qualification, subject, calls } = await promotedAmbiguous(st)
      const contender = opposing
        ? makeQualification(subject, generation, 'confirmed-no-effect', { requestId: 'opposing-decision' })
        : qualification
      const left = await openKernel(root)
      const right = await openKernel(root)
      const results = await Promise.allSettled([apply(left, qualification), apply(right, contender)])
      assert.ok(results.some(({ status }) => status === 'fulfilled'))
      for (const result of results) {
        if (result.status === 'rejected') assert.ok(['locked', 'attempt-conflict'].includes(result.reason.code))
      }
      const [row] = await decisionRows(root)
      assert.equal((await decisionRows(root)).length, 1)
      assert.equal(row.envelope.record.revision, 2)
      const winner = row.envelope.record.payload.qualification
      assert.deepEqual(await apply(left, winner), await apply(right, winner))
      if (opposing) {
        const loser = winner.requestId === qualification.requestId ? contender : qualification
        await assert.rejects(apply(right, loser), { code: 'attempt-conflict' })
      }
      assert.equal((await qualificationEvents(root)).length, 1)
      assert.equal(calls.handler, 1)
    })
  }
})

test('invalid time never applies accounting and persisted application replays without a clock', async (t) => {
  const { root, qualification, gateway } = await promotedAmbiguous(t)
  const initial = await persistedFiles(root)
  for (const [clock, request] of [
    [() => time, { ...qualification, qualifiedAt: beforeTime }],
    [() => time, { ...qualification, qualifiedAt: later }],
    [() => '2030-01-01', qualification],
    [() => { throw new Error('clock unavailable') }, qualification],
  ]) {
    await assert.rejects(apply(await openKernel(root, { now: clock }), request))
    assert.deepEqual(await persistedFiles(root), initial)
  }
  let calls = 0
  await assert.rejects(apply(await openKernel(root, { now: () => ++calls === 1 ? later : time }), qualification))
  assert.equal(calls, 2)
  assert.equal((await decisionRows(root))[0].envelope.record.revision, 1)
  assert.equal((await qualificationEvents(root)).length, 1)
  assert.partialDeepStrictEqual(await gateway.inspect(first.operationKey), { decision: 'UNKNOWN', held: 4 })
  calls = 0
  await assert.rejects(apply(await openKernel(root, { now: () => ++calls === 1 ? time : beforeTime }), qualification))
  assert.equal((await decisionRows(root))[0].envelope.record.revision, 1)
  assert.equal((await qualificationEvents(root)).length, 1)
  const applied = await apply(await openKernel(root), qualification)
  const replay = await openKernel(root, { now: () => assert.fail('clock sampled on replay') })
  assert.deepEqual(await apply(replay, qualification), applied)
  assert.equal((await decisionRows(root))[0].envelope.record.payload.appliedAt, qualification.qualifiedAt)
})

test('a live reserved attempt and an offline-promoted reserved crash cannot qualify', { timeout: 15_000 }, async (t) => {
  await t.test('live worker', async (st) => {
    const root = await workspace(st)
    const options = config(root)
    options.tool.execute = async () => ({ outcome: 'executed', evidenceId: 'native-result' })
    await (await createActionGateway(options)).execute(second)
    const generation = await promoteTaskStore(root, options.task.id)
    const entered = Promise.withResolvers()
    const released = Promise.withResolvers()
    options.tool.execute = async () => {
      entered.resolve()
      await released.promise
      return { outcome: 'unknown' }
    }
    const gateway = await createActionGateway(options)
    const execution = gateway.execute(first)
    try {
      await Promise.race([entered.promise, execution.then(() => assert.fail('handler did not pause'))])
      const subject = await readSubject(root)
      assert.equal(subject.observedPrefix, 'reserved')
      const before = await persistedFiles(root)
      await assert.rejects(apply(await openKernel(root), makeQualification(subject, generation)), { code: 'ineligible' })
      assert.deepEqual(await persistedFiles(root), before)
    } finally {
      released.resolve()
      await execution
    }
  })
  await t.test('process ended in the handler', async (st) => {
    const root = await workspace(st)
    assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('worker.mjs', import.meta.url)), root, 'crash']),
      { status: 77 })
    const generation = await promoteTaskStore(root, config(root).task.id)
    const subject = await readSubject(root)
    assert.equal(subject.observedPrefix, 'reserved')
    const before = await persistedFiles(root)
    await assert.rejects(apply(await openKernel(root), makeQualification(subject, generation)), { code: 'ineligible' })
    assert.deepEqual(await persistedFiles(root), before)
    assert.equal((await decisionRows(root)).length, 0)
  })
})

test('R3 refuses incomplete or contradictory interrupted history', async (t) => {
  for (const variant of ['missing-result-anchor', 'pending-outbox', 'adapter-closed']) {
    await t.test(variant, async (st) => {
      const { root, qualification } = await promotedAmbiguous(st)
      const events = await journal(root)
      const [attempt] = await records(root, 'gateway-attempts')
      const record = attempt.envelope.record
      if (variant === 'missing-result-anchor') {
        assert.equal(events.at(-1).event.type, 'execution-result-recorded')
        await writeFile(await auditPath(root), events.slice(0, -1).map((entry) => JSON.stringify(entry) + '\n').join(''))
      } else if (variant === 'pending-outbox') {
        record.payload.pendingEvents = [events.at(-1).event]
        await writeEnvelope(attempt.path, attempt.envelope, record)
      } else {
        record.payload.phase = 'closed'
        record.payload.result = { status: 'confirmed-success', evidenceRef: { id: 'adapter-result', revision: 1 } }
        await writeEnvelope(attempt.path, attempt.envelope, record)
      }
      const before = await persistedFiles(root)
      await assert.rejects(apply(await openKernel(root), qualification), { code: 'ineligible' })
      assert.deepEqual(await persistedFiles(root), before)
      assert.equal((await decisionRows(root)).length, 0)
    })
  }
})

test('existing audit store deduplicates the exact qualification and refuses a changed event identity', async (t) => {
  const { root, qualification } = await promotedAmbiguous(t)
  await apply(await openKernel(root), qualification)
  const [entry] = await qualificationEvents(root)
  const { audit, projectId } = await openHistory(root)
  const store = createExecutionAuditStore(audit, projectId)
  const before = await persistedFiles(root)
  assert.deepEqual(await store.append(entry.event), entry)
  await assert.rejects(store.append({ ...entry.event, actorId: 'wrong-actor' }), { code: 'event-conflict' })
  assert.deepEqual(await persistedFiles(root), before)
})

test('illegal decision and audit relationships fail closed during replay, projection, and promotion', async (t) => {
  for (const variant of ['event-without-row', 'applied-without-event', 'duplicate-artifact',
    'changed-event', 'corrupt-chain', 'revision-three', 'native-closure']) {
    await t.test(variant, async (st) => {
      const { root, qualification, gateway, options } = await promotedAmbiguous(st)
      await apply(await openKernel(root), qualification)
      const [row] = await decisionRows(root)
      const events = await journal(root)
      const { event } = events.at(-1)
      const { audit, projectId } = await openHistory(root)
      const writeJournal = async (entries) =>
        writeFile(await auditPath(root), entries.map((entry) => JSON.stringify(entry) + '\n').join(''))
      if (variant === 'event-without-row') await unlink(row.path)
      if (variant === 'applied-without-event') await writeJournal(events.slice(0, -1))
      if (variant === 'duplicate-artifact') {
        await createExecutionAuditStore(audit, projectId).append({ ...event, id: 'other-qualification-event' })
      }
      if (variant === 'changed-event') {
        await writeJournal(events.slice(0, -1))
        await createExecutionAuditStore(audit, projectId).append({ ...event, actorId: 'wrong-actor' })
      }
      if (variant === 'corrupt-chain') {
        events.at(-1).chainHash = digest('tampered-chain')
        await writeJournal(events)
      }
      if (variant === 'revision-three') {
        await writeEnvelope(row.path, row.envelope, { ...row.envelope.record, revision: 3 })
      }
      if (variant === 'native-closure') {
        const [attempt] = await records(root, 'gateway-attempts')
        const record = attempt.envelope.record
        record.payload.phase = 'closed'
        record.payload.result = { status: 'confirmed-success', evidenceRef: { id: 'adapter-result', revision: 1 } }
        await writeEnvelope(attempt.path, attempt.envelope, record)
      }
      const before = await persistedFiles(root)
      await assert.rejects(apply(await openKernel(root), qualification))
      await assert.rejects(gateway.inspect(first.operationKey))
      await assert.rejects(promoteTaskStore(root, options.task.id))
      assert.deepEqual(await persistedFiles(root), before)
    })
  }
})

test('supported generic writes cannot advance an applied decision to revision three', async (t) => {
  const { root, qualification } = await promotedAmbiguous(t)
  await apply(await openKernel(root), qualification)
  const [row] = await decisionRows(root)
  const { state } = await openHistory(root)
  const before = await persistedFiles(root)
  await assert.rejects(state.save({ ...row.envelope.record, revision: 3 }, 2))
  assert.deepEqual(await persistedFiles(root), before)
})

test('the actual Swedish legacy store requires explicit locale verification by the paired opener', async (t) => {
  const root = await workspace(t)
  const legacy = JSON.parse(await readFile(new URL('fixtures/v0.1.0-sv-SE.json', import.meta.url), 'utf8'))
  for (const [name, contents] of Object.entries(legacy.files)) {
    const path = join(root, name)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, contents, { mode: 0o600 })
  }
  const options = { ...config(root), legacyDigestLocale: 'sv-SE' }
  options.tool.execute = async () => ({ outcome: 'unknown' })
  const gateway = await createActionGateway(options)
  assert.equal((await gateway.execute(legacyIntent(second))).decision, 'UNKNOWN')
  const historical = await readSubject(root, second.operationKey, 'sv-SE')
  assert.equal(historical.subject.digestVersion, 'legacy-v0.1')
  const generation = await promoteTaskStore(root, options.task.id, 'sv-SE')
  const subject = await readSubject(root, second.operationKey, 'sv-SE')
  assert.equal(subject.subjectDigest, historical.subjectDigest)
  assert.notEqual(subject.expectedState, historical.expectedState)
  const qualification = makeQualification(subject, generation)
  const initial = await persistedFiles(root)
  const refusalInSwedish = inLocale('sv-SE', `
    import { openKernel } from ${JSON.stringify(new URL('reconciliation-decision-fixture.mjs', import.meta.url).href)}
    const locale = Intl.Collator().resolvedOptions().locale
    const q = ${JSON.stringify(qualification)}
    const failures = []
    for (const options of [{}, { legacyDigestLocale: 'en-US' }]) {
      try {
        const kernel = await openKernel(${JSON.stringify(root)}, options)
        await kernel.adjudicator.apply(kernel.issuer.issue(q))
        failures.push(false)
      } catch {
        failures.push(true)
      }
    }
    console.log(JSON.stringify({ locale, failures }))
  `)
  assert.deepEqual(refusalInSwedish, { locale: 'sv-SE', failures: [true, true] })
  assert.deepEqual(await persistedFiles(root), initial)
  await apply(await openKernel(root, { legacyDigestLocale: 'sv-SE' }), qualification)
  assert.equal((await decisionRows(root))[0].envelope.digestVersion, 'utf16-v1')
  assert.deepEqual(await readSubject(root, second.operationKey, 'sv-SE'), subject)
  assert.equal((await gateway.inspect(second.operationKey)).reason, 'reconciled-effect')
  await assertOnlyDecisionAndAuditChanged(root, initial)
})

test('deterministic adjudication uses the explicit clock and never constructs an ambient collator', async (t) => {
  const { root, qualification } = await promotedAmbiguous(t)
  const decisionBytes = []
  for (const locale of ['en-US', 'sv-SE']) {
    const replica = await workspace(t)
    await cp(root, replica, { recursive: true })
    assert.equal(inLocale(locale, `
      import { openKernel } from ${JSON.stringify(new URL('reconciliation-decision-fixture.mjs', import.meta.url).href)}
      const realDate = Date
      Intl.Collator = new Proxy(Intl.Collator, {
        apply() { throw new Error('collator called for deterministic scope') },
        construct() { throw new Error('collator constructed for deterministic scope') },
      })
      globalThis.Date = new Proxy(realDate, {
        apply() { throw new Error('ambient time sampled') },
        construct(target, args) {
          if (!args.length) throw new Error('ambient time sampled')
          return Reflect.construct(target, args)
        },
        get(target, key) {
          if (key === 'now') throw new Error('ambient time sampled')
          return Reflect.get(target, key)
        },
      })
      const kernel = await openKernel(${JSON.stringify(replica)}, { now: () => ${JSON.stringify(time)} })
      await kernel.adjudicator.apply(kernel.issuer.issue(${JSON.stringify(qualification)}))
      console.log(JSON.stringify(true))
    `), true)
    const [row] = await decisionRows(replica)
    decisionBytes.push(await readFile(row.path))
  }
  assert.deepEqual(decisionBytes[0], decisionBytes[1])
})

test('the pinned R2 baseline reads promoted history and refuses an R3-bearing allowance', async (t) => {
  const isolated = await workspace(t)
  const repository = fileURLToPath(new URL('..', import.meta.url))
  const frozen = execFileSync('git', ['archive', '--format=tar', acceptedR2, 'package.json', 'dist'], { cwd: repository })
  execFileSync('tar', ['-xf', '-', '-C', isolated], { input: frozen })
  const { createActionGateway: oldGateway } = await import(pathToFileURL(join(isolated, 'dist/index.js')).href)
  const { root, qualification, options, calls, gateway } = await promotedAmbiguous(t, 'confirmed-no-effect')
  const prior = await oldGateway(options)
  assert.partialDeepStrictEqual(await prior.inspect(first.operationKey), { decision: 'UNKNOWN', held: 4, remaining: 6 })
  await apply(await openKernel(root), qualification)
  assert.partialDeepStrictEqual(await gateway.inspect(first.operationKey), { decision: 'BLOCKED', reason: 'reconciled-no-effect', held: 0, remaining: 10 })
  const before = await persistedFiles(root)
  const previousCalls = { ...calls }
  await assert.rejects(prior.inspect(first.operationKey))
  await assert.rejects(prior.execute(first))
  await assert.rejects((await oldGateway(options)).inspect(first.operationKey))
  assert.equal(calls.handler, previousCalls.handler)
  assert.equal(calls.review, previousCalls.review)
  assert.deepEqual(await persistedFiles(root), before)
})

test('a full valid audit journal keeps revision one held and byte-preserves the journal', async (t) => {
  const { root, qualification, subject, gateway } = await promotedAmbiguous(t)
  const path = await auditPath(root)
  const prior = await readFile(path, 'utf8')
  const entries = [prior]
  const final = (await journal(root)).at(-1)
  let sequence = final.sequence
  let previousHash = final.chainHash
  let bytes = Buffer.byteLength(prior)
  const limit = 16 * 1024 * 1024
  const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  while (true) {
    sequence++
    const event = {
      schemaVersion: 'execution-audit-event/v0.1', id: 'padding-' + sequence,
      projectId: qualification.projectId, taskId: qualification.taskId, runId: subject.subject.binding.runId,
      occurredAt: time, type: 'reconciliation-started', actorId: 'host', observationCode: 'padding',
      subjectRef: { kind: 'artifact', id: 'full-journal-fixture', revision: 1 },
    }
    const eventHash = hash(event)
    const chainHash = hash([sequence, previousHash, eventHash])
    const line = JSON.stringify({ schemaVersion: 'execution-audit-envelope/v0.1', sequence, event, previousHash, eventHash, chainHash }) + '\n'
    const length = Buffer.byteLength(line)
    if (bytes + length > limit) break
    entries.push(line)
    previousHash = chainHash
    bytes += length
  }
  const full = entries.join('')
  await writeFile(path, full)
  await assert.rejects(apply(await openKernel(root), qualification))
  assert.equal((await decisionRows(root))[0].envelope.record.revision, 1)
  assert.equal(await readFile(path, 'utf8'), full)
  assert.partialDeepStrictEqual(await gateway.inspect(first.operationKey), { decision: 'UNKNOWN', held: 4 })
})

async function extendRun(root, subject) {
  const { state, projectId } = await openHistory(root)
  const { taskId, binding } = subject.subject
  await state.exclusive(async (port) => {
    const workflow = createTaskRunStore(port, projectId)
    const owner = await workflow.loadTask(taskId)
    const run = await workflow.loadRun(binding.runId)
    assert.equal(run.status, 'blocked')
    const extension = transitionRun(owner.task, run, {
      id: 'separately-authorized-run-extension', type: 'reconcile', projectId, taskId, runId: run.id,
      expectedRevision: run.revision, blockedRevision: run.revision, occurredAt: later,
      actionRef: binding.proposalRef, resolution: 'resolved', resolutionRef: { id: 'external-resolution', revision: 1 },
    })
    assert.equal(extension.status, 'applied')
    await workflow.saveRun(extension.run, run.revision)
  })
}

test('an applied decision survives a legitimate later Run extension and verifies the original prefix', async (t) => {
  const { root, qualification, subject, gateway } = await promotedAmbiguous(t, 'confirmed-no-effect')
  const kernel = await openKernel(root)
  const applied = await apply(kernel, qualification)
  await extendRun(root, subject)
  const after = await persistedFiles(root)
  assert.equal((await readSubject(root)).status, 'ineligible')
  assert.deepEqual(await apply(kernel, qualification), applied)
  assert.partialDeepStrictEqual(await gateway.inspect(first.operationKey), { reason: 'reconciled-no-effect', held: 0, remaining: 10 })
  assert.deepEqual(await persistedFiles(root), after)
})

test('a legitimate Run extension makes pending qualification stale without releasing the hold', async (t) => {
  const { root, qualification, subject, gateway } = await promotedAmbiguous(t, 'confirmed-no-effect')
  let calls = 0
  const kernel = await openKernel(root, { now: () => {
    if (++calls > 1) throw new Error('clock unavailable')
    return time
  } })
  await assert.rejects(apply(kernel, qualification), { code: 'invalid-clock' })
  assert.equal((await decisionRows(root))[0].envelope.record.revision, 1)
  assert.equal((await qualificationEvents(root)).length, 1)
  await extendRun(root, subject)
  const after = await persistedFiles(root)
  await assert.rejects(apply(await openKernel(root), qualification), { code: 'stale-state' })
  assert.partialDeepStrictEqual(await gateway.inspect(first.operationKey), { decision: 'UNKNOWN', held: 4, remaining: 6 })
  assert.deepEqual(await persistedFiles(root), after)
})
