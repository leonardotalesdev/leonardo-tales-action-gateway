import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import * as gatewayApi from '../dist/index.js'
import { computeSnapshotChecksum as digest } from '../dist/internal/digest.js'
import { approvalDecisionId, approvalRequestId } from '../dist/internal/gateway-approval.js'
import { openLocalAuditPort, openLocalRecordStore } from '../dist/internal/local-store.js'
import { readReconciliationSubject } from '../dist/internal/reconciliation.js'
import { config, first, inLocale, legacyIntent, persistedFiles, records, second, workspace } from './fixture.mjs'

const { createActionGateway } = gatewayApi

async function openHistory(directory, legacyDigestLocale) {
  const [{ envelope }] = await records(directory, 'action-allowance')
  const { projectId } = envelope.record
  const state = await openLocalRecordStore(join(directory, 'state'), projectId, { legacyDigestLocale })
  const audit = await openLocalAuditPort(join(directory, 'audit'), projectId)
  return { state, audit, projectId }
}

function recoveryReader(history, transform = (_kind, record) => record, auditTransform = (value) => value) {
  let writes = 0
  const unexpectedWrite = () => { writes++; throw new Error('R1 attempted a write or lock') }
  const state = {
    checksumFor: history.state.checksumFor,
    async read(kind, id) { return transform(kind, await history.state.read(kind, id), id) },
    create: unexpectedWrite,
    save: unexpectedWrite,
    exclusive: unexpectedWrite,
  }
  const audit = {
    async read() { return auditTransform(await history.audit.read()) },
    appendLine: unexpectedWrite,
  }
  return async (key, projectId = history.projectId) => {
    try { return await readReconciliationSubject(state, audit, projectId, key) }
    finally { assert.equal(writes, 0) }
  }
}

async function ambiguousHistory(t) {
  const root = await workspace(t)
  let calls = 0
  const options = config(root)
  options.tool.execute = async () => { calls++; return { outcome: 'unknown' } }
  const gateway = await createActionGateway(options)
  const receipt = await gateway.execute(first)
  assert.equal(receipt.decision, 'UNKNOWN')
  return { root, gateway, receipt, history: await openHistory(root), calls: () => calls }
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]))
}

test('the granted reserved prefix and completed UNKNOWN prefix are both recognizable without writes or dispatch', { timeout: 15_000 }, async (t) => {
  const directory = await workspace(t)
  const started = Promise.withResolvers()
  const finish = Promise.withResolvers()
  let invocations = 0
  const options = config(directory)
  options.timeoutMs = 30_000
  options.tool.execute = async () => {
    invocations++
    started.resolve()
    await finish.promise
    return { outcome: 'unknown' }
  }
  const gateway = await createActionGateway(options)
  const execution = gateway.execute(first)
  let reserved
  let read
  try {
    await Promise.race([started.promise, execution])
    const history = await openHistory(directory)
    read = recoveryReader(history)
    const before = await persistedFiles(directory)
    reserved = await read(first.operationKey)
    assert.equal(reserved.status, 'eligible')
    assert.equal(reserved.observedPrefix, 'reserved')
    assert.deepEqual(await read(first.operationKey), reserved)
    const beforeGrant = recoveryReader(history, undefined, (value) =>
      value.trimEnd().split('\n').slice(0, -1).join('\n') + '\n')
    assert.deepEqual(await beforeGrant(first.operationKey), { status: 'ineligible', reason: 'unsupported-prefix' })
    assert.deepEqual(await persistedFiles(directory), before)
    assert.equal(invocations, 1)
  } finally {
    finish.resolve()
    await execution
  }
  const observed = await execution
  assert.equal(observed.decision, 'UNKNOWN')
  const before = await persistedFiles(directory)
  const unresolved = await read(first.operationKey)
  assert.equal(unresolved.status, 'eligible')
  assert.equal(unresolved.observedPrefix, 'reconciliation-required')
  assert.equal(unresolved.subjectDigest, reserved.subjectDigest)
  assert.deepEqual(unresolved.subject, reserved.subject)
  assert.notEqual(unresolved.expectedState, reserved.expectedState)
  const [{ envelope: attempt }] = await records(directory, 'gateway-attempts')
  const [{ envelope: approval }] = await records(directory, 'approval-decisions')
  assert.partialDeepStrictEqual(unresolved.subject, {
    operationKey: first.operationKey,
    originalRunId: first.runId,
    amount: first.input.rows,
    unit: options.task.unit,
    digestVersion: 'utf16-v1',
    inputDigest: observed.inputDigest,
    proposalDigest: observed.proposalDigest,
    attemptId: attempt.record.id,
    approvalRequestId: observed.approvalRequestId,
    approvalRequestDigest: approval.record.payload.requestDigest,
    approvalDecisionId: approval.record.id,
  })
  assert.equal(digest(unresolved.subject.binding), digest(attempt.record.payload.binding))
  assert.deepEqual(await gateway.execute({ ...first, runId: 'replay' }), { ...observed, replayed: true })
  assert.deepEqual(await persistedFiles(directory), before)
  assert.equal(invocations, 1)
  assert.deepEqual(Object.keys(gatewayApi), ['createActionGateway'])
  assert.deepEqual(Object.keys(gateway).sort(), ['execute', 'inspect'])
})

test('expected state is independent of object order, locale, and subsequent activity on other operations', async (t) => {
  const { root, gateway, history } = await ambiguousHistory(t)
  const read = recoveryReader(history)
  const original = await read(first.operationKey)
  assert.equal(original.status, 'eligible')
  assert.match(original.expectedState, /^[a-f0-9]{64}$/)
  assert.match(original.subjectDigest, /^[a-f0-9]{64}$/)
  const reordered = recoveryReader(history, (_kind, row) => reverseKeys(row))
  assert.deepEqual(await reordered(first.operationKey), original)
  const runInLocale = (locale) => inLocale(locale, `
    import { join } from 'node:path'
    import { openLocalAuditPort, openLocalRecordStore } from ${JSON.stringify(new URL('../dist/internal/local-store.js', import.meta.url).href)}
    import { readReconciliationSubject } from ${JSON.stringify(new URL('../dist/internal/reconciliation.js', import.meta.url).href)}
    const root = ${JSON.stringify(root)}
    const project = ${JSON.stringify(history.projectId)}
    const state = await openLocalRecordStore(join(root, 'state'), project)
    const audit = await openLocalAuditPort(join(root, 'audit'), project)
    const result = await readReconciliationSubject(state, audit, project, ${JSON.stringify(first.operationKey)})
    console.log(JSON.stringify({ locale: Intl.Collator().resolvedOptions().locale, subject: result.subjectDigest, token: result.expectedState }))
  `)
  for (const locale of ['en-US', 'sv-SE']) {
    assert.deepEqual(runInLocale(locale), { locale, subject: original.subjectDigest, token: original.expectedState })
  }
  assert.equal((await gateway.execute(second)).decision, 'UNKNOWN')
  assert.deepEqual(await read(first.operationKey), original)
  const other = await read(second.operationKey)
  assert.equal(other.status, 'eligible')
  assert.notEqual(other.subjectDigest, original.subjectDigest)
  assert.notEqual(other.expectedState, original.expectedState)
})

test('similarly shaped operations cannot borrow another operation’s durable history', async (t) => {
  const { root, gateway, history, calls } = await ambiguousHistory(t)
  const sibling = { ...first, operationKey: second.operationKey, runId: second.runId }
  assert.equal((await gateway.execute(sibling)).decision, 'UNKNOWN')
  const read = recoveryReader(history)
  const original = await read(first.operationKey)
  const other = await read(sibling.operationKey)
  assert.equal(original.status, 'eligible')
  assert.equal(other.status, 'eligible')
  assert.equal(original.subject.inputDigest, other.subject.inputDigest)
  const before = await persistedFiles(root)

  for (const [kind, originalId, otherId] of [
    ['gateway-attempts', original.subject.attemptId, other.subject.attemptId],
    ['execution', original.subject.binding.executionId, other.subject.binding.executionId],
    ['proposals', original.subject.binding.proposalRef.id, other.subject.binding.proposalRef.id],
    ['approval-requests', original.subject.approvalRequestId, other.subject.approvalRequestId],
    ['approval-decisions', original.subject.approvalDecisionId, other.subject.approvalDecisionId],
  ]) {
    const foreign = await history.state.read(kind, otherId)
    assert.ok(foreign)
    const spliced = recoveryReader(history, (readKind, row, id) =>
      readKind === kind && id === originalId ? { ...foreign, id } : row)
    assert.deepEqual(await spliced(first.operationKey), { status: 'ineligible', reason: 'invalid-history' }, kind)
    assert.deepEqual(await spliced(sibling.operationKey), other)
  }
  assert.deepEqual(await persistedFiles(root), before)
  assert.equal(calls(), 2)
})

test('matching durable links cannot substitute for the historical definition and policy input digests', async (t) => {
  const { root, history, calls } = await ambiguousHistory(t)
  const original = await recoveryReader(history)(first.operationKey)
  assert.equal(original.status, 'eligible')
  const { subject } = original
  const { binding } = subject
  const hash = history.state.checksumFor(subject.digestVersion)
  const request = await history.state.read('approval-requests', subject.approvalRequestId)
  const decision = await history.state.read('approval-decisions', subject.approvalDecisionId)
  assert.ok(request && decision)
  const before = await persistedFiles(root)
  for (const field of ['definitionDigest', 'policyInputDigest']) {
    await t.test(field, async () => {
      // Keep the copies of the binding and the dependent approval references consistent.
      const bindingWithWrongDigest = { ...binding, [field]: digest(field) }
      const requestId = approvalRequestId(bindingWithWrongDigest, hash)
      const decisionId = approvalDecisionId(requestId)
      const requestPayload = { ...request.payload, id: requestId, binding: bindingWithWrongDigest }
      const decisionPayload = { ...decision.payload, id: decisionId, requestId,
        requestDigest: hash(requestPayload), bindingDigest: hash(bindingWithWrongDigest) }
      const spliced = recoveryReader(history, (kind, row, id) => {
        if (kind === 'approval-requests' && id === requestId) return { ...request, id, payload: requestPayload }
        if (kind === 'approval-decisions' && id === decisionId) return { ...decision, id, payload: decisionPayload }
        if (kind === 'runs' && id === binding.runId) {
          const events = row.payload.appliedEvents.map((event) => event.type === 'resolve-approval'
            ? { ...event, approvalRef: { ...event.approvalRef, id: decisionId } } : event)
          return { ...row, payload: { ...row.payload, appliedEvents: events } }
        }
        if (id === binding.proposalRef.id && kind === 'proposals') {
          return { ...row, payload: { ...row.payload, binding: bindingWithWrongDigest, requestId } }
        }
        if ((kind === 'action-allowance' && id === binding.proposalRef.id)
          || (kind === 'gateway-attempts' && id === subject.attemptId)) {
          return { ...row, payload: { ...row.payload, binding: bindingWithWrongDigest } }
        }
        return row
      })
      assert.deepEqual(await spliced(first.operationKey), { status: 'ineligible', reason: 'invalid-history' })
    })
  }
  assert.deepEqual(await persistedFiles(root), before)
  assert.equal(calls(), 1)
})

test('missing, pending, cap-blocked, and natively closed operations are not recovery subjects', async (t) => {
  const directory = await workspace(t)
  const options = config(directory)
  options.review = async ({ operationKey }) => operationKey === first.operationKey ? 'PENDING' : 'APPROVED'
  const gateway = await createActionGateway(options)
  const blocked = { ...second, input: { ...second.input, rows: 11 } }
  const closed = { ...second, runId: 'closed-run', operationKey: 'closed' }
  assert.equal((await gateway.execute(first)).decision, 'APPROVAL_REQUIRED')
  assert.equal((await gateway.execute(blocked)).reason, 'task_limit')
  assert.equal((await gateway.execute(closed)).decision, 'EXECUTED')
  const read = recoveryReader(await openHistory(directory))
  const before = await persistedFiles(directory)
  for (const [key, reason] of [
    ['missing', 'missing-operation'],
    [first.operationKey, 'not-held'],
    [blocked.operationKey, 'not-held'],
    [closed.operationKey, 'closed-attempt'],
  ]) {
    assert.deepEqual(await read(key), { status: 'ineligible', reason }, key)
  }
  assert.deepEqual(await persistedFiles(directory), before)
})

test('contradictory or unsupported history fails closed', async (t) => {
  const { root, history, calls } = await ambiguousHistory(t)
  const before = await persistedFiles(root)
  const cases = [
    ['missing attempt', 'gateway-attempts', () => null, 'missing-attempt'],
    ['wrong Task', 'action-allowance', (row) => { row.payload.binding.taskId = 'task-other' }],
    ['wrong Run', 'action-allowance', (row) => { row.payload.runId = 'another-run' }],
    ['wrong key', 'action-allowance', (row) => { row.payload.key = 'another-key' }],
    ['wrong proposal digest', 'action-allowance', (row) => { row.payload.proposalDigest = digest('other') }],
    ['wrong measured amount', 'action-allowance', (row) => { row.payload.amount++ }],
    ['wrong measured unit', 'action-allowance', (row) => { row.payload.task.unit = 'other' }],
    ['wrong approval binding', 'approval-decisions', (row) => { row.payload.bindingDigest = digest('other') }],
    ['contradictory execution identity', 'execution', (row) => { row.payload.executionIdentity = 'action-other' }],
    ['wrong attempt identity', 'gateway-attempts', (row) => { row.payload.binding.executionId = 'execution-other' }],
    ['provisional known result', 'gateway-attempts', (row) => {
      row.payload.result = { status: 'confirmed-success', evidenceRef: { id: 'provisional', revision: 1 } }
    }, 'unsupported-prefix'],
    ['unsupported attempt version', 'gateway-attempts', (row) => { row.payload.schemaVersion = 'gateway-attempt/v0.2' }],
    ['unsupported digest selector', 'gateway-attempts', (row) => { row.digestVersion = 'unknown' }],
  ]
  for (const [name, expectedKind, mutate, reason = 'invalid-history'] of cases) {
    await t.test(name, async () => {
      const read = recoveryReader(history, (kind, record) => {
        const manifestCase = name === 'wrong measured unit'
        if (!record || kind !== expectedKind ||
          (kind === 'action-allowance' && (record.id === 'task-allowance') !== manifestCase)) return record
        const copy = structuredClone(record)
        return mutate(copy) === null ? null : copy
      })
      assert.deepEqual(await read(first.operationKey), { status: 'ineligible', reason })
    })
  }
  for (const [name, alterAudit, reason] of [
    ['corrupt audit envelope', (value) => value + '{}\n', 'invalid-history'],
    ['empty history', () => '', 'unsupported-prefix'],
    ['valid prefix before dispatch authority grant', (value) => {
      const lines = value.trimEnd().split('\n')
      const grant = lines.findIndex((line) => JSON.parse(line).event.type === 'execution-authority-granted')
      assert.ok(grant > 0)
      return lines.slice(0, grant).join('\n') + '\n'
    }, 'unsupported-prefix'],
  ]) {
    await t.test(name, async () => {
      const read = recoveryReader(history, undefined, alterAudit)
      assert.deepEqual(await read(first.operationKey), { status: 'ineligible', reason })
    })
  }
  assert.deepEqual(await recoveryReader(history)(first.operationKey, 'project-wrong'),
    { status: 'ineligible', reason: 'invalid-history' })
  assert.equal(calls(), 1)
  assert.deepEqual(await persistedFiles(root), before)
})

test('a damaged on-disk execution envelope is refused and preserved', async (t) => {
  const { root, history, calls } = await ambiguousHistory(t)
  const [{ path, envelope }] = await records(root, 'execution')
  const damaged = JSON.stringify({ ...envelope, checksum: '0'.repeat(64) }) + '\n'
  await writeFile(path, damaged)
  const before = await persistedFiles(root)
  assert.deepEqual(await recoveryReader(history)(first.operationKey), { status: 'ineligible', reason: 'invalid-history' })
  assert.deepEqual(await persistedFiles(root), before)
  assert.equal(calls(), 1)
})

test('a resumed Swedish legacy operation retains its original approval identity without migration by R1', async (t) => {
  const directory = await workspace(t)
  const fixture = JSON.parse(await readFile(new URL('fixtures/v0.1.0-sv-SE.json', import.meta.url), 'utf8'))
  for (const [relative, contents] of Object.entries(fixture.files)) {
    const path = join(directory, relative)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, contents, { mode: 0o600 })
  }
  const options = config(directory)
  options.legacyDigestLocale = fixture.locale
  let calls = 0
  options.tool.execute = async () => { calls++; return { outcome: 'unknown' } }
  const gateway = await createActionGateway(options)
  const oldRequest = fixture.review[second.operationKey]
  const held = await gateway.execute(legacyIntent(second))
  assert.equal(held.decision, 'UNKNOWN')
  const history = await openHistory(directory, fixture.locale)
  const read = recoveryReader(history)
  const before = await persistedFiles(directory)
  const wrongLocale = recoveryReader(await openHistory(directory, 'en-US'))
  assert.deepEqual(await wrongLocale(second.operationKey), { status: 'ineligible', reason: 'invalid-history' })
  const subject = await read(second.operationKey)
  assert.equal(subject.status, 'eligible')
  assert.partialDeepStrictEqual(subject.subject, {
    digestVersion: 'legacy-v0.1',
    proposalDigest: held.proposalDigest,
    approvalRequestId: oldRequest.requestId,
    approvalRequestDigest: oldRequest.requestDigest,
  })
  assert.deepEqual(await read(second.operationKey), subject)

  for (const [name, unsafeValue] of [
    ['Proxy', (observe) => new Proxy({}, {
      get(target, key, receiver) { observe(); return Reflect.get(target, key, receiver) },
      getPrototypeOf(target) { observe(); return Reflect.getPrototypeOf(target) },
      ownKeys(target) { observe(); return Reflect.ownKeys(target) },
      getOwnPropertyDescriptor(target, key) { observe(); return Reflect.getOwnPropertyDescriptor(target, key) },
    })],
    ['accessor', (observe) => ({ get property() { observe(); return 'getter' } })],
    ['toJSON', (observe) => ({ toJSON() { observe(); return 'serialization hook' } })],
    ['unsupported prototype', (observe) => Object.create({ toJSON() { observe(); return 'inherited hook' } })],
    ['unsupported value', () => 7n],
  ]) {
    await t.test(`legacy input rejects ${name} before hashing`, async () => {
      let visited = false
      let invoked = 0
      const unsafeRead = recoveryReader(history, (kind, row) => {
        if (kind !== 'proposals') return row
        const copy = structuredClone(row)
        copy.payload.proposal.input.payload.unsafe = unsafeValue(() => { invoked++ })
        visited = true
        return copy
      })
      assert.deepEqual(await unsafeRead(second.operationKey), { status: 'ineligible', reason: 'invalid-history' })
      assert.equal(visited, true)
      assert.equal(invoked, 0)
    })
  }
  assert.deepEqual(await read(second.operationKey), subject)
  assert.deepEqual(await persistedFiles(directory), before)
  assert.equal(calls, 1)
})
