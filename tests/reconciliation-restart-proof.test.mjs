import assert from 'node:assert/strict'
import { lstat, unlink } from 'node:fs/promises'
import test from 'node:test'
import { first, persistedFiles, records, second } from './fixture.mjs'
import {
  allowance, assertDecision, assertEntries, assertOnlyDecisionAndEventChanged, prepareAmbiguous, proofRequest, proofScope, proofTimeout, writerPath,
} from './reconciliation-process-proof-fixture.mjs'

const crashWorker = new URL('./reconciliation-crash-worker.mjs', import.meta.url)
const bounds = { timeout: proofTimeout }
const held = [4, 0, 6]
const settled = [0, 4, 6]
const busy = { status: 'refused', code: 'store-busy' }
const final = (status) => ({ status, ...proofRequest, outcome: 'reconciled-effect' })

async function start(scope, options) {
  const worker = await scope.start(options)
  assert.equal(worker.ready?.type, 'ready', JSON.stringify(worker.openingReceipt))
  worker.send({ type: 'start' })
  return worker
}

async function releaseAssessment(scope, options) {
  const worker = await start(scope, options)
  await worker.next('assessed')
  worker.send({ type: 'release', epoch: 1 })
  return worker
}

async function fastReplay(scope) {
  const worker = await start(scope, { failResolver: true, failClock: true })
  assert.deepEqual(await worker.result(), {
    receipt: final('replayed'), resolverCalls: 0, clockCalls: 0, installs: [],
  })
  return worker.pid
}

async function assertHeld(gateway, root) {
  const allowanceRows = (await records(root, 'action-allowance')).map(({ envelope }) => envelope.record)
  const { cap } = allowanceRows.find(({ id }) => id === 'task-allowance').payload.sourceManifest.record.payload.task
  const operation = allowanceRows.find(({ payload }) => payload.key === first.operationKey)
  assert.equal(operation.payload.phase, 'held')
  assert.deepEqual([operation.payload.amount, 0, cap - operation.payload.amount], held)
  assert.deepEqual(await allowance(gateway), held)
}

test('R5 a lost acknowledgement leaves one accounting transition and a zero-callback restart replay', bounds, async (t) => {
  const scope = await proofScope(t)
  const { root } = scope
  try {
    const { gateway, qualification } = await prepareAmbiguous(scope)
    await assertHeld(gateway, root)
    await assertDecision(root, { revision: 0, eventCount: 0 })
    await assertEntries(scope, [first])
    const before = await persistedFiles(root)

    const writer = await releaseAssessment(scope, { loseAcknowledgement: true })
    const withheld = await writer.next('durable-without-acknowledgement')
    assert.deepEqual(withheld.installs, [1, 2])
    await assert.rejects(lstat(await writerPath(root)), { code: 'ENOENT' })
    await assertDecision(root, { revision: 2, eventCount: 1, qualification })
    assert.deepEqual(await allowance(gateway), settled)
    await assertEntries(scope, [first])
    const applied = await persistedFiles(root)
    await assertOnlyDecisionAndEventChanged(root, before, applied)
    await writer.kill()
    assert.ok(writer.trace().phases.every(({ type }) => type !== 'result'), 'the caller saw no success receipt')

    assert.notEqual(await fastReplay(scope), writer.pid)
    const altered = await start(scope, {
      request: { ...proofRequest, evidenceRef: { ...proofRequest.evidenceRef, revision: 2 } },
      failResolver: true, failClock: true,
    })
    assert.deepEqual(await altered.result(), {
      receipt: { status: 'refused', code: 'request-conflict' }, resolverCalls: 0, clockCalls: 0, installs: [],
    })
    await assertDecision(root, { revision: 2, eventCount: 1, qualification })
    assert.deepEqual(await allowance(gateway), settled)
    assert.deepEqual(await persistedFiles(root), applied)
    await assertEntries(scope, [first])
  } finally { await scope.close() }
})

test('R5 public revision-2 directory-sync uncertainty retains the writer and fences other processes', bounds, async (t) => {
  const scope = await proofScope(t)
  const { root } = scope
  try {
    const { gateway, qualification } = await prepareAmbiguous(scope)
    await assertHeld(gateway, root)
    await assertEntries(scope, [first])
    const before = await persistedFiles(root)
    const preopened = await scope.start({ failResolver: true, failClock: true })

    const writing = await releaseAssessment(scope, { failRev2Sync: true })
    assert.notEqual(preopened.pid, writing.pid)
    assert.deepEqual(await writing.result(), {
      receipt: { status: 'refused', code: 'write-uncertain' },
      resolverCalls: 1, clockCalls: 2, installs: [1, 2], syncFaults: 1,
    })
    const lock = await writerPath(root)
    const retained = await lstat(lock)
    assert.ok(retained.isFile())
    assert.equal(retained.mode & 0o777, 0o600)
    await assert.rejects(lstat(await writerPath(root, 'audit')), { code: 'ENOENT' })
    await assertDecision(root, { revision: 2, eventCount: 1, qualification })
    const visible = await persistedFiles(root)

    preopened.send({ type: 'start' })
    const expected = { receipt: busy, resolverCalls: 0, clockCalls: 0, installs: [] }
    assert.deepEqual(await preopened.result(), expected)
    const fresh = await scope.start({ failResolver: true, failClock: true })
    assert.deepEqual(fresh.openingReceipt, expected)
    await assert.rejects(gateway.inspect(first.operationKey), { code: 'locked' })
    await assert.rejects(gateway.execute(first), { code: 'locked' })
    await assert.rejects(gateway.execute(second), { code: 'locked' })
    const unchanged = await lstat(lock)
    assert.deepEqual([unchanged.dev, unchanged.ino], [retained.dev, retained.ino])
    assert.deepEqual(await persistedFiles(root), visible)
    await assertEntries(scope, [first])

    // The failed writer has exited. This is fixture intervention after the
    // protected refusal assertions, and there is no equivalent automatic action.
    await unlink(lock)
    await fastReplay(scope)
    const accessible = await persistedFiles(root)
    await assertOnlyDecisionAndEventChanged(root, before, accessible)
    assert.deepEqual(await allowance(gateway), settled)
    assert.deepEqual(await gateway.execute(first), { ...await gateway.inspect(first.operationKey), replayed: true })
    assert.deepEqual(await persistedFiles(root), accessible)
    await assertEntries(scope, [first])
  } finally { await scope.close() }
})

const crashes = [
  ['qualification:temporary-synced', 0, 0],
  ['qualification:directory-synced', 1, 0],
  ['after-audit', 1, 1],
]

async function verifyReattestation(scope, gateway, pending, qualification, eventCount) {
  const unavailable = await start(scope, { failResolver: true })
  assert.deepEqual(await unavailable.result(), {
    receipt: { status: 'refused', code: 'resolver-failed' }, resolverCalls: 1, clockCalls: 0, installs: [],
  })
  const unresolved = await releaseAssessment(scope, { outcome: 'unresolved' })
  assert.deepEqual(await unresolved.result(), {
    receipt: { status: 'unresolved', ...proofRequest }, resolverCalls: 1, clockCalls: 0, installs: [],
  })
  const changed = await releaseAssessment(scope, { changes: { qualifiedAt: '2029-12-31T23:59:59.999Z' } })
  assert.deepEqual(await changed.result(), {
    receipt: { status: 'refused', code: 'request-conflict' }, resolverCalls: 1, clockCalls: 0, installs: [],
  })
  await assertDecision(scope.root, { revision: 1, eventCount, qualification })
  assert.deepEqual(await persistedFiles(scope.root), pending)
  await assertHeld(gateway, scope.root)
  await assertEntries(scope, [first])
}

for (const [cut, revision, eventCount] of crashes) {
  test(`R5 public restart observes the durable prefix after SIGKILL at ${cut}`, bounds, async (t) => {
    const scope = await proofScope(t)
    const { root } = scope
    try {
      const { gateway, qualification } = await prepareAmbiguous(scope)
      const original = await persistedFiles(root)
      const child = scope.spawn(crashWorker, [root, cut, JSON.stringify(qualification)])
      assert.deepEqual(await child.waitExit(), { code: null, signal: 'SIGKILL' })
      await assertDecision(root, { revision, eventCount, qualification })

      const lockPath = await writerPath(root)
      const lock = await lstat(lockPath)
      assert.ok(lock.isFile())
      assert.equal(lock.mode & 0o777, 0o600)
      const crashed = await persistedFiles(root)
      const temporary = Object.keys(crashed).filter((path) => path.includes('.tmp-'))
      assert.equal(temporary.length, revision === 0 ? 1 : 0)
      const blocked = await scope.start({ failResolver: true, failClock: true })
      assert.deepEqual(blocked.openingReceipt, { receipt: busy, resolverCalls: 0, clockCalls: 0, installs: [] })
      await assert.rejects(gateway.execute(first), { code: 'locked' })
      assert.deepEqual(await persistedFiles(root), crashed)
      await assertEntries(scope, [first])

      // Clear the known lock only after the owned fixture's writer has been reaped.
      await unlink(lockPath)
      await assertHeld(gateway, root)
      const pending = await persistedFiles(root)
      if (revision) await verifyReattestation(scope, gateway, pending, qualification, eventCount)
      else {
        const failed = await start(scope, { failResolver: true })
        assert.deepEqual(await failed.result(), {
          receipt: { status: 'refused', code: 'resolver-failed' }, resolverCalls: 1, clockCalls: 0, installs: [],
        })
        assert.deepEqual(await persistedFiles(root), pending)
      }

      const restarting = await releaseAssessment(scope)
      assert.deepEqual(await restarting.result(), {
        receipt: final('applied'), resolverCalls: 1, clockCalls: 2, installs: revision ? [2] : [1, 2],
      })
      await assertDecision(root, { revision: 2, eventCount: 1, qualification })
      const applied = await persistedFiles(root)
      for (const name of temporary) {
        assert.deepEqual(applied[name], pending[name], 'the orphaned temporary was never adopted')
        original[name] = pending[name]
      }
      await assertOnlyDecisionAndEventChanged(root, original, applied)
      assert.deepEqual(await allowance(gateway), settled)
      await fastReplay(scope)
      assert.deepEqual(await persistedFiles(root), applied)
      await assertEntries(scope, [first])
    } finally { await scope.close() }
  })
}
