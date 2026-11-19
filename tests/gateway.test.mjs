import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createActionGateway } from '@leonardo-tales/action-gateway'
import { config, first, second, third, records, workspace } from './fixture.mjs'

const worker = new URL('./worker.mjs', import.meta.url)
const effects = (directory) => readFile(join(directory, 'effects'), 'utf8')
const matches = (value, subset) => assert.partialDeepStrictEqual(value, subset)

test('exactly approved actions charge one Task across Runs and stop at its hard cap', async (t) => {
  const options = config(await workspace(t))
  const reviews = []
  options.review = async (request) => { reviews.push(request); return 'APPROVED' }
  const gateway = await createActionGateway(options)
  matches(await gateway.execute(first), { decision: 'EXECUTED', settled: 4, held: 0, remaining: 6 })
  matches(await gateway.execute(second), { decision: 'EXECUTED', settled: 7, remaining: 3 })
  const blocked = await gateway.execute(third)
  matches(blocked, { decision: 'BLOCKED', reason: 'task_limit', requested: 4, remaining: 3 })
  assert.equal(reviews.length, 3)
  assert.equal(reviews[2].requestId, blocked.approvalRequestId)
  assert.deepEqual(await gateway.inspect(third.operationKey), blocked)
  assert.equal(await effects(options.directory), '4\n3\n')
})

test('a new Run replays the original result and changed arguments conflict without dispatch', async (t) => {
  const options = config(await workspace(t))
  const original = await (await createActionGateway(options)).execute(first)
  const reopened = await createActionGateway(options)
  assert.deepEqual(await reopened.execute({ ...first, runId: 'later' }), { ...original, replayed: true })
  for (const input of [{ rows: 4, batch: 'changed' }, { rows: 0 }]) {
    matches(await reopened.execute({ ...first, input }), { decision: 'CONFLICT', reason: 'operation-conflict' })
  }
  assert.equal(await effects(options.directory), '4\n')
})

test('the meter, exact approval, stored proposal and resumed handler see canonical input', async (t) => {
  const options = config(await workspace(t))
  const intent = { ...first, input: { ...first.input, samples: [-0, { offset: -0 }] } }
  const canonical = { ...first.input, samples: [0, { offset: 0 }] }
  function check(input) {
    assert.ok(Object.is(input.samples[0], 0))
    assert.ok(Object.is(input.samples[1].offset, 0))
    assert.deepEqual(JSON.parse(JSON.stringify(input)), canonical)
  }
  const calls = { meters: 0, reviews: 0, handlers: 0 }
  const reviews = []
  options.tool.amount = (input) => { check(input); calls.meters++; return input.rows }
  options.review = async (request) => {
    check(request.input)
    calls.reviews++
    reviews.push(request)
    return calls.reviews === 1 ? 'PENDING' : 'APPROVED'
  }
  options.tool.execute = async (input) => {
    check(input)
    calls.handlers++
    return { outcome: 'executed', evidenceId: 'canonical-export' }
  }
  const receipt = await (await createActionGateway(options)).execute(intent)
  matches(receipt, { decision: 'APPROVAL_REQUIRED', requested: 4 })
  const [entry] = await records(options.directory, 'proposals')
  const stored = entry.envelope.record.payload
  check(stored.proposal.input.payload)
  assert.equal(stored.binding.proposalDigest, receipt.proposalDigest)
  // Golden exact request from the independently validated foundation, for this fixed clock and fixture.
  assert.equal(reviews[0].requestDigest, '462177ccb3621d04271aaffe50082817175d723807a2f74f596f2fb8ac258d85')
  const reopened = await createActionGateway(options)
  matches(await reopened.execute({ ...intent, input: { ...canonical, samples: [1, { offset: 0 }] } }), { decision: 'CONFLICT' })
  matches(await reopened.execute({ ...intent, input: canonical }), {
    decision: 'EXECUTED', approvalRequestId: reviews[0].requestId, proposalDigest: receipt.proposalDigest, settled: 4,
  })
  assert.deepEqual(reviews[1], reviews[0])
  assert.deepEqual(calls, { meters: 2, reviews: 2, handlers: 1 })
})

test('pending approval cannot transfer Runs and serialized receipts and decisions have no authority', async (t) => {
  const options = config(await workspace(t))
  const gateway = await createActionGateway({ ...options, review: async () => 'PENDING' })
  const pending = await gateway.execute(first)
  matches(pending, { decision: 'APPROVAL_REQUIRED', remaining: 10 })
  assert.ok(!JSON.stringify(pending).includes('"batch"'))
  for (const extra of [{ approval: 'APPROVED' }, { amount: 1 }, pending]) {
    await assert.rejects(() => gateway.execute({ ...first, ...extra }))
  }
  const reopened = await createActionGateway(options)
  matches(await reopened.execute({ ...first, runId: 'renamed' }), { reason: 'operation-bound-to-original-run' })
  await assert.rejects(() => effects(options.directory), { code: 'ENOENT' })
  matches(await reopened.execute(first), { decision: 'EXECUTED', approvalRequestId: pending.approvalRequestId })
})

test('reopening cannot change a Task cap, meter charge, unit, operator or action revision', async (t) => {
  const options = config(await workspace(t))
  await (await createActionGateway(options)).execute(first)
  for (const change of [
    { task: { ...options.task, cap: 99 } }, { task: { ...options.task, unit: 'pages' } },
    { tool: { ...options.tool, revision: 2 } }, { approverId: 'replacement' },
  ]) {
    const other = await createActionGateway({ ...options, ...change })
    await assert.rejects(() => other.execute(second), /task-configuration-conflict/)
  }
  const changedMeter = await createActionGateway({ ...options, tool: { ...options.tool, amount: () => 1 } })
  matches(await changedMeter.execute(first), { decision: 'CONFLICT' })
  assert.equal(await effects(options.directory), '4\n')
})

test('a denied exact request stays denied after restart', async (t) => {
  const options = config(await workspace(t))
  const gateway = await createActionGateway({ ...options, review: async () => 'DENIED' })
  const denied = await gateway.execute(first)
  matches(denied, { decision: 'BLOCKED', reason: 'approval-denied', remaining: 10 })
  assert.deepEqual(await (await createActionGateway(options)).execute(first), { ...denied, replayed: true })
  await assert.rejects(() => effects(options.directory), { code: 'ENOENT' })
})

test('approval expiring during review cannot reach dispatch', async (t) => {
  const options = config(await workspace(t))
  let now = options.now()
  const gateway = await createActionGateway({ ...options, now: () => now, review: async (request) => {
    now = request.expiresAt
    return 'APPROVED'
  } })
  matches(await gateway.execute(first), { decision: 'BLOCKED', reason: 'expired', held: 0, remaining: 10 })
  await assert.rejects(() => effects(options.directory), { code: 'ENOENT' })
})

test('a second process holds capacity while the first refuses and records the decision-time basis', { timeout: 15_000 }, async (t) => {
  const directory = await workspace(t)
  const options = config(directory)
  const gateway = await createActionGateway(options)
  await gateway.execute(first)
  const child = fork(worker, [directory, 'hold'])
  const exit = once(child, 'exit')
  const message = () => once(child, 'message', { signal: AbortSignal.timeout(7000) }).then(([value]) => value)
  const basis = { requested: 4, cap: 10, settled: 4, held: 3, remaining: 3, reason: 'task_limit' }
  try {
    assert.equal(await message(), 'entered-handler')
    matches(await gateway.execute({ ...second, runId: 'overlap' }), { decision: 'UNKNOWN', held: 3, remaining: 3 })
    matches(await gateway.execute(third), { decision: 'BLOCKED', refusalBasis: basis, held: 3, remaining: 3 })
    const blocked = (await records(directory, 'action-allowance')).find(({ envelope }) => envelope.record.payload.key === third.operationKey)
    matches(blocked.envelope.record, { revision: 2, payload: { amount: 4, phase: 'blocked', refusalBasis: {
      reason: 'task_limit', cap: 10, settled: 4, held: 3, remaining: 3,
    } } })
    const released = message()
    child.send('finish')
    matches(await released, { reason: 'confirmed-no-effect', evidenceId: 'verified-empty-export', held: 0, remaining: 6 })
    assert.equal((await exit)[0], 0)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exit
  }
  const reopened = await createActionGateway(options)
  const historical = await reopened.inspect(third.operationKey)
  matches(historical, { decision: 'BLOCKED', settled: 4, held: 0, remaining: 6, refusalBasis: basis })
  assert.deepEqual(await reopened.execute({ ...third, runId: 'later' }), { ...historical, replayed: true })
  assert.equal(await effects(directory), '4\n')
})

test('two processes approving distinct operations against the last three units cannot both dispatch', { timeout: 20_000 }, async (t) => {
  const directory = await workspace(t)
  const gateway = await createActionGateway(config(directory))
  await gateway.execute(first)
  await gateway.execute(second)
  const keys = ['contender-a', 'contender-b']
  const children = []
  const exits = []
  try {
    // Prepare each exact request before letting either operator approve.
    for (const key of keys) {
      const child = fork(worker, [directory, 'contend', key])
      children.push(child)
      exits.push(once(child, 'exit'))
      const [message] = await once(child, 'message', { signal: AbortSignal.timeout(7000) })
      assert.equal(message, 'at-review')
    }
    for (const child of children) child.send('approve')
    for (const [code] of await Promise.all(exits)) assert.equal(code, 0)
    const produced = (await effects(directory)).trim().split('\n')
    assert.ok(produced.length <= 3, 'both contenders produced an effect')

    // A busy writer may refuse early. Retry each original identity after quiescence.
    for (const key of keys) {
      await gateway.execute({ runId: key, operationKey: key, input: { rows: 2, batch: key } })
    }
    assert.equal(await effects(directory), '4\n3\n2\n')
    const totals = await gateway.inspect(first.operationKey)
    assert.equal(totals.settled + totals.held, 9)
    assert.equal(totals.remaining, 1)
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill()
    await Promise.all(exits)
  }
})

test('a lost handler response retains exposure even after the handler produced an effect', async (t) => {
  const options = config(await workspace(t))
  const apply = options.tool.execute
  const gateway = await createActionGateway({ ...options, tool: { ...options.tool, async execute(input, signal) {
    await apply(input, signal)
    throw new Error('lost response')
  } } })
  matches(await gateway.execute(first), { decision: 'UNKNOWN', held: 4, settled: 0, remaining: 6 })
  const reopened = await createActionGateway(options)
  matches(await reopened.execute(first), { replayed: true, decision: 'UNKNOWN', held: 4 })
  assert.equal(await effects(options.directory), '4\n')
})

test('real process exit after a synced effect preserves the hold and refuses blind redispatch', { timeout: 15_000 }, async (t) => {
  const directory = await workspace(t)
  const child = fork(worker, [directory, 'crash'])
  const [code] = await once(child, 'exit')
  assert.equal(code, 77)
  const reopened = await createActionGateway(config(directory))
  matches(await reopened.inspect(first.operationKey), { decision: 'UNKNOWN', held: 4, settled: 0, remaining: 6 })
  matches(await reopened.execute({ ...first, runId: 'after-crash' }), { decision: 'UNKNOWN', replayed: true })
  matches(await reopened.execute({ ...second, input: { rows: 7 } }), { reason: 'task_limit', held: 4 })
  assert.equal(await effects(directory), '4\n')
})

test('an older refusal with no recorded balance stays blocked', async (t) => {
  const options = config(await workspace(t))
  const intent = { ...first, input: { rows: 11 } }
  const gateway = await createActionGateway(options)
  matches(await gateway.execute(intent), { decision: 'BLOCKED', reason: 'task_limit' })
  const { path, envelope } = (await records(options.directory, 'action-allowance')).find(({ envelope }) => envelope.record.payload.key === first.operationKey)
  delete envelope.record.payload.refusalBasis
  // Fixture only: reconstruct the historical checked envelope, then use only the public API.
  const { computeSnapshotChecksum } = await import('../dist/internal/digest.js')
  envelope.checksum = computeSnapshotChecksum(envelope.record)
  await writeFile(path, JSON.stringify(envelope))
  const reopened = await createActionGateway(options)
  matches(await reopened.inspect(first.operationKey), { decision: 'BLOCKED', reason: 'task_limit', refusalBasis: null })
  matches(await reopened.execute(intent), { decision: 'BLOCKED', replayed: true })
  await assert.rejects(() => effects(options.directory), { code: 'ENOENT' })
})
