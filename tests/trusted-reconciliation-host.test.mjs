import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { createActionGateway, createTrustedReconciliationHost } from '../dist/index.js'
import { computeSnapshotChecksum as digest } from '../dist/internal/digest.js'
import { encodeRecordEnvelope } from '../dist/internal/local-store.js'
import { promoteTaskStore } from '../dist/internal/store-promotion.js'
import { createTaskRunStore } from '../dist/internal/task-run-store.js'
import { transitionRun } from '../dist/internal/task-run.js'
import { config, first, legacyIntent, persistedFiles, projectDirectory, records, second, time, workspace } from './fixture.mjs'
import { auditPath, decisionRows, journal, openHistory, openKernel, promotedAmbiguous, readSubject } from './reconciliation-decision-fixture.mjs'

const actorId = 'trusted-resolver'
const later = '2030-01-01T00:00:00.001Z'
const request = Object.freeze({
  requestId: 'host-request-1', operationKey: first.operationKey,
  evidenceRef: Object.freeze({ id: 'captured-dossier', revision: 4 }),
})

function hostOptions(root, resolveEvidence, host = {}) {
  return { directory: root, taskId: config(root).task.id, host: { actorId, now: () => time, resolveEvidence, ...host } }
}

function assessment(context, outcome = 'confirmed-effect') {
  const { requestId, actorId, evidenceRef, subject } = context
  const binding = { requestId, actorId, evidenceRef: { ...evidenceRef }, subjectDigest: subject.subjectDigest, expectedState: subject.expectedState }
  const details = { binding, qualifiedAt: time, evidenceDigest: digest('provider-dossier-revision-4') }
  return outcome === 'confirmed-effect'
    ? { status: outcome, ...details, effectOccurredDigest: digest('original-effect-observed') }
    : { status: outcome, ...details, effectAbsentDigest: digest('original-effect-absent'),
      attemptFinalityDigest: digest('original-attempt-cannot-produce-effect') }
}

function finalReceipt(status, outcome, requested = request) {
  return { status, ...requested, outcome }
}

function refused(code) {
  return { status: 'refused', code }
}

function publicShape(value) {
  assert.ok(Object.isFrozen(value))
  if (value.evidenceRef) assert.ok(Object.isFrozen(value.evidenceRef))
  return structuredClone(value)
}

async function qualificationEvents(root) {
  return (await journal(root)).filter(({ event }) => event.type === 'reconciliation-decision-qualified')
}

async function writeEnvelope(row) {
  await writeFile(row.path, JSON.stringify(encodeRecordEnvelope(row.envelope.record, row.envelope.digestVersion)) + '\n')
}

async function assertUnchanged(fixture, before) {
  assert.deepEqual(await persistedFiles(fixture.root), before)
  assert.equal(fixture.calls.handler, 1)
  assert.partialDeepStrictEqual(await fixture.gateway.inspect(first.operationKey), { decision: 'UNKNOWN', held: 4, settled: 0 })
}

test('the public request rejects extra authority, forged handles and hooked shapes before any evidence call', async (t) => {
  const fixture = await promotedAmbiguous(t)
  let resolverCalls = 0
  const controller = await createTrustedReconciliationHost(hostOptions(fixture.root, async () => {
    resolverCalls++
    return { status: 'unresolved' }
  }))
  const before = await persistedFiles(fixture.root)
  const privateHandle = (await openKernel(fixture.root)).issuer.issue(fixture.qualification)
  let hooks = 0
  const trap = () => { hooks++; throw new Error('public data hook') }
  const wrongValues = [
    ...['outcome', 'confirmedEffect', 'confirmedNoEffect', 'proof', 'actorId', 'qualifiedAt', 'subjectDigest',
      'expectedState', 'storeGeneration', 'attemptId', 'executionIdentity', 'evidenceDigest',
      'effectOccurredDigest', 'effectAbsentDigest', 'attemptFinalityDigest', 'Q', 'handle', 'legacyDigestLocale']
      .map((field) => ({ ...request, [field]: 'caller-controlled' })),
    fixture.qualification,
    privateHandle,
    Object.freeze(Object.create(null)),
    new Proxy(request, { ownKeys: trap, getPrototypeOf: trap, get: trap }),
    new Proxy({}, { getPrototypeOf: trap }),
    Object.create(request),
    Object.defineProperty({ ...request }, 'operationKey', { get: trap }),
    { ...request, [Symbol('extra')]: true },
    { ...request, requestId: 'x'.repeat(257) },
    { ...request, operationKey: 'not a local key' },
    { ...request, evidenceRef: new Proxy(request.evidenceRef, { ownKeys: trap, get: trap }) },
    { ...request, evidenceRef: Object.defineProperty({ ...request.evidenceRef }, 'id', { get: trap }) },
    { ...request, evidenceRef: { ...request.evidenceRef, outcome: 'confirmed-effect' } },
    { ...request, evidenceRef: { ...request.evidenceRef, id: 'x'.repeat(257) } },
    ...[0, -1, 1.23, Number.MAX_SAFE_INTEGER + 1, '4'].map((revision) => ({ ...request, evidenceRef: { ...request.evidenceRef, revision } })),
    [], null, false, undefined,
  ]
  for (const value of wrongValues) {
    assert.deepEqual(await controller.reconcile(value), refused('invalid-request'))
  }
  assert.equal(resolverCalls, 0)
  assert.equal(hooks, 0)
  await assertUnchanged(fixture, before)
})

test('the controller captures its callbacks and actor and gives the resolver an exact deeply frozen subject', async (t) => {
  const fixture = await promotedAmbiguous(t)
  const entered = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const originalRequest = structuredClone(request)
  let clockCalls = 0
  let returned
  const options = hostOptions(fixture.root, async (context, signal) => {
    entered.resolve({ context, signal })
    await resume.promise
    returned = assessment(context)
    return returned
  }, { now() {
    clockCalls++
    // The normalized assessment has already crossed the private issuer boundary.
    returned.binding.evidenceRef.revision = 8
    returned.effectOccurredDigest = digest('changed-after-return')
    return time
  } })
  const controller = await createTrustedReconciliationHost(options)
  assert.deepEqual(Reflect.ownKeys(controller), ['reconcile'])
  assert.ok(Object.isFrozen(controller))
  options.host.actorId = 'replaced-actor'
  options.host.now = () => assert.fail('clock was reread from host options')
  options.host.resolveEvidence = async () => assert.fail('resolver was reread from host options')
  const result = controller.reconcile(originalRequest)
  originalRequest.operationKey = 'replaced-operation'
  originalRequest.evidenceRef.revision = 9
  const { context, signal } = await Promise.race([entered.promise, result.then((value) => assert.fail(JSON.stringify(value)))])
  try {
    const { binding, ...historical } = fixture.subject.subject
    const expected = {
      projectId: historical.projectId, taskId: historical.taskId, originalTaskId: historical.originalTaskId,
      runId: binding.runId, originalRunId: historical.originalRunId, operationKey: historical.operationKey,
      actionRef: binding.actionRef, target: historical.target, amount: historical.amount, unit: historical.unit,
      digestVersion: historical.digestVersion, inputDigest: historical.inputDigest, proposalDigest: historical.proposalDigest,
      approvalRequestId: historical.approvalRequestId, approvalRequestDigest: historical.approvalRequestDigest,
      approvalDecisionId: historical.approvalDecisionId, attemptId: historical.attemptId,
      executionIdentity: binding.executionIdentity, subjectDigest: fixture.subject.subjectDigest,
      expectedState: fixture.subject.expectedState, storeGeneration: fixture.generation, observedPrefix: 'reconciliation-required',
    }
    assert.deepEqual(structuredClone(context), { requestId: request.requestId, actorId, evidenceRef: request.evidenceRef,
      subject: structuredClone(expected) })
    assert.ok(signal instanceof AbortSignal)
    assert.equal(signal.aborted, false)
    assert.throws(() => { context.requestId = 'replaced-request' }, TypeError)
    assert.throws(() => { context.subject.operationKey = 'replaced-operation' }, TypeError)
    assert.throws(() => { context.subject.actionRef.revision = 8 }, TypeError)
    assert.throws(() => { context.subject.target.resource = 'replaced-target' }, TypeError)
    assert.throws(() => { context.evidenceRef.revision = 8 }, TypeError)
  } finally {
    resume.resolve()
    await result
  }
  assert.deepEqual(publicShape(await result), finalReceipt('applied', 'reconciled-effect'))
  assert.equal(clockCalls, 2)
  const [row] = await decisionRows(fixture.root)
  const { qualification } = row.envelope.record.payload
  assert.equal(qualification.actorId, actorId)
  assert.deepEqual(qualification.evidenceRef, request.evidenceRef)
  assert.equal(qualification.proof.effectOccurredDigest, digest('original-effect-observed'))
  assert.equal(fixture.calls.handler, 1)
})

for (const [decision, outcome, totals] of [
  ['confirmed-effect', 'reconciled-effect', { decision: 'EXECUTED', held: 0, settled: 4, remaining: 6 }],
  ['confirmed-no-effect', 'reconciled-no-effect', { decision: 'BLOCKED', held: 0, settled: 0, remaining: 10 }],
]) {
  test(`${decision} uses one R3 transition and exact replay needs no resolver, clock or dispatch`, async (t) => {
    const fixture = await promotedAmbiguous(t)
    let resolverCalls = 0
    let clockCalls = 0
    const controller = await createTrustedReconciliationHost(hostOptions(fixture.root, async (context) => {
      resolverCalls++
      return assessment(context, decision)
    }, { now: () => { clockCalls++; return time } }))
    assert.deepEqual(publicShape(await controller.reconcile(request)), finalReceipt('applied', outcome))
    assert.equal(resolverCalls, 1)
    assert.equal(clockCalls, 2)
    assert.partialDeepStrictEqual(await fixture.gateway.inspect(first.operationKey), { ...totals, reason: outcome })
    const [row] = await decisionRows(fixture.root)
    const [event] = await qualificationEvents(fixture.root)
    assert.equal(row.envelope.record.revision, 2)
    assert.equal(event.event.subjectRef.id, row.envelope.record.id)

    // Existing execution reads the final projection, even when the caller tries another Run ID.
    const before = await persistedFiles(fixture.root)
    const restarted = await createTrustedReconciliationHost(hostOptions(fixture.root, async () => {
      resolverCalls++
      throw new Error('external resolver unavailable')
    }, { now() { clockCalls++; throw new Error('clock unavailable') } }))
    assert.deepEqual(publicShape(await restarted.reconcile(request)), finalReceipt('replayed', outcome))
    assert.partialDeepStrictEqual(await fixture.gateway.execute({ ...first, runId: 'another-run' }), { ...totals, replayed: true })
    for (const [changed, code] of [
      [{ ...request, requestId: 'different-request' }, 'attempt-conflict'],
      [{ ...request, operationKey: second.operationKey }, 'request-conflict'],
      [{ ...request, evidenceRef: { ...request.evidenceRef, id: 'different-dossier' } }, 'request-conflict'],
      [{ ...request, evidenceRef: { ...request.evidenceRef, revision: 5 } }, 'request-conflict'],
    ]) {
      assert.deepEqual(await restarted.reconcile(changed), refused(code))
    }
    const otherActor = await createTrustedReconciliationHost(hostOptions(fixture.root, async () => {
      resolverCalls++
      return { status: 'unresolved' }
    }, { actorId: 'other-actor' }))
    assert.deepEqual(await otherActor.reconcile(request), refused('request-conflict'))
    assert.equal(resolverCalls, 1)
    assert.equal(clockCalls, 2)
    assert.equal(fixture.calls.handler, 1)
    assert.deepEqual(await persistedFiles(fixture.root), before)

    if (decision === 'confirmed-no-effect') {
      const next = { ...second, input: { ...second.input, rows: 7 } }
      assert.partialDeepStrictEqual(await fixture.gateway.execute(next), { operationKey: next.operationKey, held: 7, remaining: 3 })
      assert.equal(fixture.calls.handler, 2)
    }
  })
}

test('a valid evidence selector without a qualifying assessment grants no authority', async (t) => {
  const fixture = await promotedAmbiguous(t)
  const before = await persistedFiles(fixture.root)
  let hooks = 0
  const trap = () => { hooks++; throw new Error('must not run') }
  function without(key) {
    return (context) => {
      const noEffect = assessment(context, 'confirmed-no-effect')
      delete noEffect[key]
      return noEffect
    }
  }
  const bindings = [
    ['requestId', 'cross-wired-request'], ['actorId', 'different-actor'],
    ['evidenceRef', { ...request.evidenceRef, revision: 5 }],
    ['evidenceRef', { ...request.evidenceRef, id: 'different-dossier' }],
    ['subjectDigest', digest('different-subject')], ['expectedState', digest('different-state')],
  ]
  for (const [field, value] of bindings) {
    await t.test(`assessment with different ${field} ${value?.revision ?? value?.id ?? ''}`.trim(), async () => {
      const controller = await createTrustedReconciliationHost(hostOptions(fixture.root, async (context) => {
        const valid = assessment(context)
        return { ...valid, binding: { ...valid.binding, [field]: value } }
      }))
      assert.deepEqual(await controller.reconcile(request), refused('evidence-mismatch'))
      await assertUnchanged(fixture, before)
    })
  }
  const malformed = [
    ['absent finding only', without('attemptFinalityDigest')],
    ['finality finding only', without('effectAbsentDigest')],
    ['timeout only', () => ({ status: 'confirmed-no-effect', timedOut: true })],
    ['not found only', () => ({ status: 'confirmed-no-effect', notFound: true })],
    ['worker stopped only', () => ({ status: 'confirmed-no-effect', workerStopped: true })],
    ['safe-to-retry flag', (context) => ({ ...assessment(context, 'confirmed-no-effect'), safeToRetry: true })],
    ['malformed dossier digest', (context) => ({ ...assessment(context), evidenceDigest: '0'.repeat(65536) })],
    ['uppercase effect digest', (context) => ({ ...assessment(context), effectOccurredDigest: 'A'.repeat(64) })],
    ['unrecognized outcome', () => ({ status: 'safe-to-retry' })],
    ['raw content', (context) => ({ ...assessment(context), providerBody: 'private evidence' })],
    ['unresolved with extra keys', () => ({ status: 'unresolved', providerFailure: true })],
    ['proxy assessment', (context) => new Proxy(assessment(context), { getPrototypeOf: trap, ownKeys: trap })],
    ['accessor discriminant', (context) => Object.defineProperty(assessment(context), 'status', { get: trap })],
    ['accessor digest', (context) => Object.defineProperty(assessment(context), 'evidenceDigest', { get: trap })],
    ['accessor binding', (context) => {
      const valid = assessment(context)
      return { ...valid, binding: Object.defineProperty(valid.binding, 'actorId', { get: trap }) }
    }],
    ['custom prototype', (context) => Object.create(assessment(context))],
    ['symbol key', (context) => ({ ...assessment(context), [Symbol('internal')]: 'no' })],
    ['array', () => []],
  ]
  for (const [name, malformedAssessment] of malformed) {
    await t.test(name, async () => {
      const controller = await createTrustedReconciliationHost(hostOptions(fixture.root, async (context) => malformedAssessment(context)))
      assert.deepEqual(await controller.reconcile(request), refused('invalid-assessment'))
      assert.equal(hooks, 0)
      await assertUnchanged(fixture, before)
    })
  }
  for (const [name, resolver] of [
    ['synchronous provider failure', () => { throw new Error('provider-secret-diagnostic') }],
    ['rejected provider authentication', async () => { throw new Error('credential-body-must-not-leak') }],
    ['provider unavailable', () => Promise.reject(new Error('database unavailable'))],
  ]) {
    await t.test(name, async () => {
      const controller = await createTrustedReconciliationHost(hostOptions(fixture.root, resolver))
      assert.deepEqual(await controller.reconcile(request), refused('resolver-failed'))
      await assertUnchanged(fixture, before)
    })
  }

  // The exact ref still resolves when the caller explicitly assesses pinned revision 4.
  const unresolved = await createTrustedReconciliationHost(hostOptions(fixture.root, async () => ({ status: 'unresolved' })))
  assert.deepEqual(publicShape(await unresolved.reconcile(request)), { status: 'unresolved', ...request })
  await assertUnchanged(fixture, before)
  const verified = await createTrustedReconciliationHost(hostOptions(fixture.root, async (context) => assessment(context)))
  assert.deepEqual(publicShape(await verified.reconcile(request)), finalReceipt('applied', 'reconciled-effect'))
  assert.equal(fixture.calls.handler, 1)
})

test('resolver return validation does not invoke thenable, Promise-proxy or poisoned native Promise hooks', async (t) => {
  const fixture = await promotedAmbiguous(t)
  const before = await persistedFiles(fixture.root)
  let hooks = 0
  const trap = () => { hooks++; throw new Error('must not run') }
  class PromiseSubclass extends Promise {
    static get [Symbol.species]() { return trap() }
  }
  for (const value of [
    { then: trap },
    Object.defineProperty({}, 'then', { get: trap }),
    Object.create(Promise.prototype),
    new Proxy(Promise.resolve({ status: 'unresolved' }), { get: trap, getPrototypeOf: trap, ownKeys: trap }),
    Object.defineProperty(Promise.resolve({ status: 'unresolved' }), 'then', { get: trap }),
    Object.defineProperty(Promise.resolve({ status: 'unresolved' }), 'constructor', { get: trap }),
    PromiseSubclass.resolve({ status: 'unresolved' }),
    { status: 'unresolved' },
  ]) {
    const host = await createTrustedReconciliationHost(hostOptions(fixture.root, () => value))
    assert.deepEqual(await host.reconcile(request), refused('invalid-assessment'))
    assert.equal(hooks, 0)
  }
  await assertUnchanged(fixture, before)
})

for (const settle of ['resolve', 'reject']) {
  test(`the 30-second resolver deadline aborts once and consumes late ${settle} without applying`, async (t) => {
    const fixture = await promotedAmbiguous(t)
    const before = await persistedFiles(fixture.root)
    const entered = Promise.withResolvers()
    const result = Promise.withResolvers()
    let aborts = 0
    let clocks = 0
    const controller = await createTrustedReconciliationHost(hostOptions(fixture.root, (context, signal) => {
      signal.addEventListener('abort', () => aborts++)
      entered.resolve({ context, signal })
      return result.promise
    }, { now() { clocks++; return time } }))
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const pending = controller.reconcile(request)
    const { context, signal } = await Promise.race([entered.promise, pending.then((value) => assert.fail(JSON.stringify(value)))])
    t.mock.timers.tick(29_999)
    assert.equal(signal.aborted, false)
    t.mock.timers.tick(1)
    assert.deepEqual(await pending, refused('resolver-timeout'))
    assert.equal(signal.aborted, true)
    assert.equal(aborts, 1)
    result[settle](settle === 'resolve' ? assessment(context) : new Error('late provider rejection'))
    await setImmediate()
    assert.equal(aborts, 1)
    assert.equal(clocks, 0)
    await assertUnchanged(fixture, before)
  })
}

test('elapsed resolver time still expires if fulfillment runs before the scheduled timer', async (t) => {
  const fixture = await promotedAmbiguous(t)
  const before = await persistedFiles(fixture.root)
  let elapsed = 0
  t.mock.method(performance, 'now', () => elapsed)
  let signal
  const host = await createTrustedReconciliationHost(hostOptions(fixture.root, async (context, cancellation) => {
    signal = cancellation
    elapsed = 30_001
    return assessment(context)
  }))
  assert.deepEqual(await host.reconcile(request), refused('resolver-timeout'))
  assert.equal(signal.aborted, true)
  await assertUnchanged(fixture, before)
})

test('the resolver holds neither writer and unrelated execution can proceed before R3 application', async (t) => {
  const fixture = await promotedAmbiguous(t)
  const { state, audit, projectId } = await openHistory(fixture.root)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const controller = await createTrustedReconciliationHost(hostOptions(fixture.root, async (context) => {
    entered.resolve()
    await release.promise
    return assessment(context)
  }))
  const pending = controller.reconcile(request)
  try {
    await Promise.race([entered.promise, pending.then((value) => assert.fail(JSON.stringify(value)))])
    // These independent ports take actual filesystem locks. The audit probe appends nothing.
    let stateEntries = 0
    let auditEntries = 0
    await state.exclusive(async () => { stateEntries++ })
    await audit.appendLine(() => { auditEntries++; return null })
    assert.equal(stateEntries, 1)
    assert.equal(auditEntries, 1)
    assert.equal((await decisionRows(fixture.root)).length, 0)
    assert.equal((await qualificationEvents(fixture.root)).length, 0)
    assert.deepEqual(await fixture.gateway.inspect(request.operationKey), fixture.receipt)
    assert.equal((await fixture.gateway.execute(second)).decision, 'UNKNOWN')
    assert.equal(fixture.calls.handler, 2)
    assert.equal((await readSubject(fixture.root)).expectedState, fixture.subject.expectedState)
    assert.equal(fixture.subject.subject.projectId, projectId)
  } finally {
    release.resolve()
    await pending
  }
  assert.deepEqual(await pending, finalReceipt('applied', 'reconciled-effect'))
  assert.equal(fixture.calls.handler, 2)
  assert.equal((await qualificationEvents(fixture.root)).length, 1)
})

test('audit contention after evidence resolution leaves only R3 revision 1 and reopens as pending unresolved', async (t) => {
  const fixture = await promotedAmbiguous(t)
  const auditLock = join(await projectDirectory(fixture.root, 'audit'), '.writer.lock')
  const stateLock = join(await projectDirectory(fixture.root, 'state'), '.writer.lock')
  let applies = 0
  const controller = await createTrustedReconciliationHost(hostOptions(fixture.root, async (context) => {
    await assert.rejects(readFile(stateLock), { code: 'ENOENT' })
    await writeFile(auditLock, 'independent writer', { flag: 'wx' })
    return assessment(context)
  }, { now() { applies++; return time } }))
  try {
    assert.deepEqual(await controller.reconcile(request), refused('store-busy'))
    const [row] = await decisionRows(fixture.root)
    assert.equal(row.envelope.record.revision, 1)
    assert.equal((await qualificationEvents(fixture.root)).length, 0)
    assert.equal(applies, 1)
    assert.equal(await readFile(auditLock, 'utf8'), 'independent writer')
  } finally {
    await unlink(auditLock)
  }

  const before = await persistedFiles(fixture.root)
  let calls = 0
  const reopened = await createTrustedReconciliationHost(hostOptions(fixture.root, async () => {
    calls++
    return { status: 'unresolved' }
  }))
  assert.deepEqual(await reopened.reconcile(request), { status: 'unresolved', ...request })
  assert.equal(calls, 1)
  await assertUnchanged(fixture, before)
})

test('construction refuses absent, unsafe, unpromoted or corrupt stores without creating Task files or calling evidence code', async (t) => {
  const empty = await workspace(t)
  let calls = 0
  const resolveEvidence = async () => { calls++; return { status: 'unresolved' } }
  const missing = join(empty, 'missing')
  const link = join(empty, 'link')
  const external = await workspace(t)
  await symlink(external, link, 'dir')
  const unsafe = join(empty, 'world-readable')
  await mkdir(unsafe, { mode: 0o755 })
  const emptyBefore = await readdir(empty, { recursive: true })
  for (const [directory, code] of [[empty, 'store-not-found'], [missing, 'store-not-found'],
    [link, 'unsafe-store'], [unsafe, 'unsafe-store'], ['./relative', 'unsafe-store']]) {
    await assert.rejects(createTrustedReconciliationHost(hostOptions(directory, resolveEvidence)), { code })
  }
  assert.deepEqual(await readdir(empty, { recursive: true }), emptyBefore)

  const v1 = await workspace(t)
  const options = config(v1)
  options.tool.execute = async () => ({ outcome: 'unknown' })
  const gateway = await createActionGateway(options)
  assert.equal((await gateway.execute(first)).decision, 'UNKNOWN')
  const unpromoted = await persistedFiles(v1)
  await assert.rejects(createTrustedReconciliationHost(hostOptions(v1, resolveEvidence)), { code: 'promotion-required' })
  assert.deepEqual(await persistedFiles(v1), unpromoted)

  await promoteTaskStore(v1, options.task.id)
  const original = await persistedFiles(v1)
  const cfg = hostOptions(v1, resolveEvidence)
  await assert.rejects(createTrustedReconciliationHost({ ...cfg, taskId: 'another-task' }), { code: 'store-not-found' })
  let hooks = 0
  const trap = () => { hooks++; throw new Error('host config getter') }
  for (const invalid of [
    { ...cfg, extra: true },
    { ...cfg, legacyDigestLocale: 'invalid_locale!' },
    { ...cfg, taskId: 'task with spaces' },
    { ...cfg, host: { ...cfg.host, actorId: 'actor with spaces' } },
    { ...cfg, host: { ...cfg.host, resolveEvidence: null } },
    { ...cfg, host: { ...cfg.host, now: null } },
    { ...cfg, host: { ...cfg.host, now: async () => time } },
    { ...cfg, host: { ...cfg.host, [Symbol('extra')]: true } },
    { ...cfg, host: new Proxy(cfg.host, { ownKeys: trap, get: trap }) },
    Object.create(cfg),
    Object.defineProperty({ ...cfg }, 'directory', { get: trap }),
    new Proxy(cfg, { getOwnPropertyDescriptor: trap, get: trap }),
  ]) {
    await assert.rejects(createTrustedReconciliationHost(invalid), { code: 'invalid-host-config' })
  }
  assert.equal(hooks, 0)
  assert.deepEqual(await persistedFiles(v1), original)

  const manifest = (await records(v1, 'action-allowance')).find(({ envelope }) => envelope.record.id === 'task-allowance')
  await unlink(manifest.path)
  const missingManifest = await persistedFiles(v1)
  await assert.rejects(createTrustedReconciliationHost(cfg), { code: 'corrupt-storage' })
  assert.deepEqual(await persistedFiles(v1), missingManifest)
  manifest.envelope.record.payload.storeGeneration = '0'.repeat(64)
  await writeEnvelope(manifest)
  const corruptManifest = await persistedFiles(v1)
  await assert.rejects(createTrustedReconciliationHost(cfg), { code: 'corrupt-storage' })
  assert.deepEqual(await persistedFiles(v1), corruptManifest)
  assert.equal(calls, 0)
})

test('unsupported, missing and native terminal histories are refused before external evidence resolution', async (t) => {
  let resolverCalls = 0
  const resolver = async () => { resolverCalls++; return { status: 'unresolved' } }
  await t.test('missing operation or attempt', async (st) => {
    const fixture = await promotedAmbiguous(st)
    const host = await createTrustedReconciliationHost(hostOptions(fixture.root, resolver))
    const before = await persistedFiles(fixture.root)
    assert.deepEqual(await host.reconcile({ ...request, operationKey: 'absent' }), refused('ineligible'))
    await assertUnchanged(fixture, before)
    const [attempt] = await records(fixture.root, 'gateway-attempts')
    await unlink(attempt.path)
    const withoutAttempt = await persistedFiles(fixture.root)
    assert.deepEqual(await host.reconcile(request), refused('ineligible'))
    assert.deepEqual(await persistedFiles(fixture.root), withoutAttempt)
  })
  await t.test('valid audit chain lacking the result anchor', async (st) => {
    const fixture = await promotedAmbiguous(st)
    const host = await createTrustedReconciliationHost(hostOptions(fixture.root, resolver))
    const events = await journal(fixture.root)
    assert.equal(events.at(-1).event.type, 'execution-result-recorded')
    await writeFile(await auditPath(fixture.root), events.slice(0, -1).map((row) => JSON.stringify(row) + '\n').join(''))
    const before = await persistedFiles(fixture.root)
    assert.deepEqual(await host.reconcile(request), refused('ineligible'))
    assert.deepEqual(await persistedFiles(fixture.root), before)
  })
  await t.test('corrupt audit before the first R3 row', async (st) => {
    const fixture = await promotedAmbiguous(st)
    const host = await createTrustedReconciliationHost(hostOptions(fixture.root, resolver))
    await writeFile(await auditPath(fixture.root), '{"event":{}}\n')
    const before = await persistedFiles(fixture.root)
    assert.deepEqual(await host.reconcile(request), refused('corrupt-storage'))
    assert.deepEqual(await persistedFiles(fixture.root), before)
  })
  await t.test('live reserved attempt', async (st) => {
    const fixture = await promotedAmbiguous(st)
    const started = Promise.withResolvers()
    const finish = Promise.withResolvers()
    const host = await createTrustedReconciliationHost(hostOptions(fixture.root, resolver))
    const gateway = await createActionGateway({ ...fixture.options,
      tool: { ...fixture.options.tool, async execute() {
        started.resolve()
        await finish.promise
        return { outcome: 'unknown' }
      } },
    })
    const execution = gateway.execute(second)
    try {
      await Promise.race([started.promise, execution.then((value) => assert.fail(JSON.stringify(value)))])
      assert.equal((await readSubject(fixture.root, second.operationKey)).observedPrefix, 'reserved')
      const before = await persistedFiles(fixture.root)
      assert.deepEqual(await host.reconcile({ ...request, operationKey: second.operationKey }), refused('ineligible'))
      assert.deepEqual(await persistedFiles(fixture.root), before)
      assert.equal((await decisionRows(fixture.root)).length, 0)
    } finally {
      finish.resolve()
      await execution
    }
  })
  await t.test('native closure', async (st) => {
    const fixture = await promotedAmbiguous(st)
    const gateway = await createActionGateway({ ...fixture.options,
      tool: { ...fixture.options.tool, async execute() {
        return { outcome: 'executed', evidenceId: 'native-terminal-effect' }
      } },
    })
    assert.equal((await gateway.execute(second)).decision, 'EXECUTED')
    const host = await createTrustedReconciliationHost(hostOptions(fixture.root, resolver))
    const before = await persistedFiles(fixture.root)
    assert.deepEqual(await host.reconcile({ ...request, operationKey: second.operationKey }), refused('ineligible'))
    assert.deepEqual(await persistedFiles(fixture.root), before)
  })
  assert.equal(resolverCalls, 0)
})

async function extendRun(fixture) {
  const { state, projectId } = await openHistory(fixture.root)
  const { taskId, binding } = fixture.subject.subject
  await state.exclusive(async (port) => {
    const workflow = createTaskRunStore(port, projectId)
    const { task } = await workflow.loadTask(taskId)
    const run = await workflow.loadRun(binding.runId)
    const extension = transitionRun(task, run, {
      id: 'authorized-test-run-extension', type: 'reconcile', projectId, taskId, runId: run.id,
      expectedRevision: run.revision, blockedRevision: run.revision, occurredAt: later,
      actionRef: binding.proposalRef, resolution: 'resolved', resolutionRef: { id: 'external-resolution', revision: 1 },
    })
    assert.equal(extension.status, 'applied')
    await workflow.saveRun(extension.run, run.revision)
  })
}

test('a held resolver cannot authorize a qualification for a changed Run, attempt, operation, generation or audit anchor', async (t) => {
  const mutations = [
    ['Run', extendRun, ['stale-state', 'ineligible']],
    ['attempt', async ({ root }) => {
      const [attempt] = await records(root, 'gateway-attempts')
      const { pendingEvents } = attempt.envelope.record.payload
      pendingEvents.push((await journal(root)).at(-1).event)
      await writeEnvelope(attempt)
    }, ['stale-state', 'ineligible', 'corrupt-storage']],
    ['operation', async ({ root }) => {
      const operation = (await records(root, 'action-allowance')).find(({ envelope }) => envelope.record.payload.key === first.operationKey)
      operation.envelope.record.payload.amount = 5
      await writeEnvelope(operation)
    }, ['stale-state', 'ineligible', 'corrupt-storage']],
    ['generation', async ({ root }) => {
      const manifest = (await records(root, 'action-allowance')).find(({ envelope }) => envelope.record.id === 'task-allowance')
      manifest.envelope.record.payload.storeGeneration = digest('different-installed-generation')
      await writeEnvelope(manifest)
    }, ['stale-state']],
    ['audit anchor', async ({ root }) => {
      const events = await journal(root)
      await writeFile(await auditPath(root), events.slice(0, -1).map((row) => JSON.stringify(row) + '\n').join(''))
    }, ['stale-state', 'ineligible', 'corrupt-storage']],
  ]
  for (const [name, mutate, codes] of mutations) {
    await t.test(name, async (st) => {
      const fixture = await promotedAmbiguous(st)
      const entered = Promise.withResolvers()
      const release = Promise.withResolvers()
      let resolverCalls = 0
      const host = await createTrustedReconciliationHost(hostOptions(fixture.root, async (context) => {
        resolverCalls++
        entered.resolve(context)
        await release.promise
        return assessment(context)
      }))
      const pending = host.reconcile(request)
      try {
        const context = await Promise.race([entered.promise, pending.then((value) => assert.fail(JSON.stringify(value)))])
        assert.equal(context.subject.expectedState, fixture.subject.expectedState)
        await mutate(fixture)
        const changed = await persistedFiles(fixture.root)
        release.resolve()
        const response = await pending
        assert.equal(response.status, 'refused')
        assert.ok(codes.includes(response.code), JSON.stringify(response))
        if (name === 'generation') assert.deepEqual(await host.reconcile(request), refused('stale-state'))
        assert.equal(resolverCalls, 1)
        assert.equal(fixture.calls.handler, 1)
        assert.equal((await decisionRows(fixture.root)).length, 0)
        assert.deepEqual(await persistedFiles(fixture.root), changed)
      } finally {
        release.resolve()
        await pending
      }
    })
  }
})

test('applied replay uses the historical Run and fails closed on missing event or contradictory native closure', async (t) => {
  const fixture = await promotedAmbiguous(t)
  let resolverCalls = 0
  let clocks = 0
  const host = await createTrustedReconciliationHost(hostOptions(fixture.root, async (context) => {
    resolverCalls++
    return assessment(context)
  }, { now() { clocks++; return time } }))
  assert.deepEqual(await host.reconcile(request), finalReceipt('applied', 'reconciled-effect'))
  await extendRun(fixture)
  assert.equal((await readSubject(fixture.root)).status, 'ineligible')
  assert.deepEqual(await host.reconcile(request), finalReceipt('replayed', 'reconciled-effect'))

  const path = await auditPath(fixture.root)
  const complete = await readFile(path)
  const events = await journal(fixture.root)
  assert.equal(events.at(-1).event.type, 'reconciliation-decision-qualified')
  await writeFile(path, events.slice(0, -1).map((row) => JSON.stringify(row) + '\n').join(''))
  const missingEvent = await persistedFiles(fixture.root)
  assert.deepEqual(await host.reconcile(request), refused('corrupt-storage'))
  assert.deepEqual(await persistedFiles(fixture.root), missingEvent)
  await writeFile(path, complete)

  const [attempt] = await records(fixture.root, 'gateway-attempts')
  attempt.envelope.record.payload.phase = 'closed'
  attempt.envelope.record.payload.result = { status: 'confirmed-success', evidenceRef: { id: 'native-proof', revision: 1 } }
  await writeEnvelope(attempt)
  const doubleClosure = await persistedFiles(fixture.root)
  assert.deepEqual(await host.reconcile(request), refused('corrupt-storage'))
  assert.deepEqual(await persistedFiles(fixture.root), doubleClosure)
  assert.equal(resolverCalls, 1)
  assert.equal(clocks, 2)
  assert.equal(fixture.calls.handler, 1)
})

test('genuine legacy history requires an explicit compatible locale before evidence assessment', async (t) => {
  const root = await workspace(t)
  const stored = JSON.parse(await readFile(new URL('fixtures/v0.1.0-sv-SE.json', import.meta.url), 'utf8'))
  for (const [name, contents] of Object.entries(stored.files)) {
    const path = join(root, name)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, contents, { mode: 0o600 })
  }
  const options = { ...config(root), legacyDigestLocale: 'sv-SE' }
  options.tool.execute = async () => ({ outcome: 'unknown' })
  const gateway = await createActionGateway(options)
  assert.equal((await gateway.execute(legacyIntent(second))).decision, 'UNKNOWN')
  await promoteTaskStore(root, options.task.id, 'sv-SE')
  const requested = { ...request, operationKey: second.operationKey }
  let calls = 0
  const trusted = hostOptions(root, async (context) => {
    calls++
    assert.equal(context.subject.digestVersion, 'legacy-v0.1')
    return assessment(context)
  })
  const before = await persistedFiles(root)
  await assert.rejects(createTrustedReconciliationHost(trusted), { code: 'legacy-locale-required' })
  // A supported but wrong locale may fail at manifest validation or at the
  // dependent historical check. Neither path calls the resolver.
  try {
    const wrong = await createTrustedReconciliationHost({ ...trusted, legacyDigestLocale: 'en-US' })
    assert.deepEqual(await wrong.reconcile(requested), refused('corrupt-storage'))
  } catch (error) {
    assert.equal(error.code, 'corrupt-storage')
  }
  assert.equal(calls, 0)
  assert.deepEqual(await persistedFiles(root), before)
  const verified = await createTrustedReconciliationHost({ ...trusted, legacyDigestLocale: 'sv-SE' })
  assert.deepEqual(await verified.reconcile(requested), finalReceipt('applied', 'reconciled-effect', requested))
  assert.equal(calls, 1)
  assert.equal((await gateway.inspect(second.operationKey)).reason, 'reconciled-effect')
})

test('deterministic R4 history does not construct a legacy collator', async (t) => {
  const fixture = await promotedAmbiguous(t)
  let attempts = 0
  const trap = () => { attempts++; throw new Error('ambient locale used') }
  t.mock.method(Intl, 'Collator', trap)
  const host = await createTrustedReconciliationHost(hostOptions(fixture.root, async (context) => assessment(context)))
  assert.deepEqual(await host.reconcile(request), finalReceipt('applied', 'reconciled-effect'))
  assert.equal(attempts, 0)
})

test('invalid trusted time is refused before the first R3 write', async (t) => {
  const fixture = await promotedAmbiguous(t)
  const before = await persistedFiles(fixture.root)
  for (const [qualifiedAt, now] of [
    ['2030-01-01', () => time],
    ['2029-12-31T23:59:59.999Z', () => time],
    [later, () => time],
    [time, () => { throw new Error('clock diagnostic') }],
  ]) {
    const host = await createTrustedReconciliationHost(hostOptions(fixture.root, async (context) => ({
      ...assessment(context), qualifiedAt,
    }), { now }))
    assert.deepEqual(await host.reconcile(request), refused('invalid-clock'))
    await assertUnchanged(fixture, before)
  }
})
