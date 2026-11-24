import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstat, unlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openReconciliationStore } from '../dist/internal/local-store.js'
import { first, persistedFiles, projectDirectory } from './fixture.mjs'
import { auditPath, decisionRows, journal, openKernel, promotedAmbiguous } from './reconciliation-decision-fixture.mjs'

const worker = fileURLToPath(new URL('./reconciliation-crash-worker.mjs', import.meta.url))
const qualificationType = 'reconciliation-decision-qualified'

async function qualificationEvents(root) {
  return (await journal(root)).filter(({ event }) => event.type === qualificationType)
}

async function projectedEffect(gateway) {
  assert.partialDeepStrictEqual(await gateway.inspect(first.operationKey), {
    decision: 'EXECUTED', reason: 'reconciled-effect', held: 0, settled: 4, remaining: 6, replayed: false,
  })
}

async function clearAbandonedWriterLock(path) {
  const stat = await lstat(path)
  assert.equal(stat.isFile(), true)
  assert.equal(stat.mode & 0o777, 0o600)
  // The test owns this Task directory and has already established that the writer is gone.
  await unlink(path)
}

const crashCases = [
  // Fault, installed revision, journal event count, state lock, audit lock, temp file.
  ['before-state-lock', 0, 0, false, false, false],
  ['before-qualification', 0, 0, true, false, false],
  ['qualification:temporary-synced', 0, 0, true, false, true],
  ['qualification:renamed', 1, 0, true, false, false],
  ['qualification:directory-synced', 1, 0, true, false, false],
  ['audit:temporary-synced', 1, 0, true, true, true],
  ['audit:renamed', 1, 1, true, true, false],
  ['audit:directory-synced', 1, 1, true, true, false],
  ['after-audit', 1, 1, true, false, false],
  ['application:temporary-synced', 1, 1, true, false, true],
  ['application:renamed', 2, 1, true, false, false],
  ['application:directory-synced', 2, 1, true, false, false],
]

for (const [fault, revision, eventCount, stateLocked, auditLocked, tempFile] of crashCases) {
  test(`R3 process death at ${fault} preserves evidence and allows only exact recovery`, async (t) => {
    const { root, gateway, calls, receipt, qualification } = await promotedAmbiguous(t)
    const before = await persistedFiles(root)
    const auditName = relative(root, await auditPath(root))
    const stateLock = join(await projectDirectory(root, 'state'), '.writer.lock')
    const auditLock = join(await projectDirectory(root, 'audit'), '.writer.lock')

    const result = spawnSync(process.execPath, [worker, root, fault, JSON.stringify(qualification)], {
      encoding: 'utf8', timeout: 10_000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, 'SIGKILL', result.stderr)

    const crashed = await persistedFiles(root)
    const rows = await decisionRows(root)
    assert.equal(rows.length, revision ? 1 : 0)
    if (revision) {
      const [row] = rows
      const { record } = row.envelope
      assert.equal(record.revision, revision)
      assert.equal(record.payload.phase, revision === 2 ? 'applied' : 'qualified')
      assert.deepEqual(record.payload.qualification, qualification)
    }
    assert.equal((await qualificationEvents(root)).length, eventCount)
    assert.equal(relative(root, stateLock) in crashed, stateLocked)
    assert.equal(relative(root, auditLock) in crashed, auditLocked)
    const temporaries = Object.keys(crashed).filter((name) => name.includes('.tmp-'))
    assert.equal(temporaries.length, tempFile ? 1 : 0)

    for (const [name, bytes] of Object.entries(before)) {
      if (name === auditName && eventCount) assert.deepEqual(crashed[name].subarray(0, bytes.length), bytes)
      else assert.deepEqual(crashed[name], bytes, name)
    }

    const kernel = await openKernel(root)
    const handle = kernel.issuer.issue(qualification)
    if (stateLocked) {
      await assert.rejects(kernel.adjudicator.apply(handle), { code: 'locked' })
      assert.deepEqual(await persistedFiles(root), crashed)
    }
    if (revision) await assert.rejects(gateway.inspect(first.operationKey), { code: 'locked' })
    else assert.deepEqual(await gateway.inspect(first.operationKey), receipt)

    if (stateLocked) await clearAbandonedWriterLock(stateLock)
    if (auditLocked) {
      const withOnlyAuditLock = await persistedFiles(root)
      await assert.rejects(kernel.adjudicator.apply(handle), { code: 'locked' })
      assert.deepEqual(await persistedFiles(root), withOnlyAuditLock)
      await clearAbandonedWriterLock(auditLock)
    }

    if (revision < 2) assert.deepEqual(await gateway.inspect(first.operationKey), receipt)
    await kernel.adjudicator.apply(handle)
    await projectedEffect(gateway)
    assert.equal((await decisionRows(root)).length, 1)
    assert.equal((await qualificationEvents(root)).length, 1)
    const applied = await persistedFiles(root)
    for (const temporary of temporaries) assert.deepEqual(applied[temporary], crashed[temporary])
    await kernel.adjudicator.apply(handle)
    assert.deepEqual(await persistedFiles(root), applied)
    assert.equal(calls.handler, 1)
  })
}

test('R3 never trusts a visible application rename during live or retained writer uncertainty', async (t) => {
  const { root, gateway, calls, qualification } = await promotedAmbiguous(t)
  const renamed = Promise.withResolvers()
  const release = Promise.withResolvers()
  let stateWrites = 0
  const kernel = await openKernel(root, {
    async stateCheckpoint(stage) {
      if (stage === 'temporary-synced') stateWrites++
      if (stage === 'renamed' && stateWrites === 2) {
        renamed.resolve()
        await release.promise
        throw new Error('injected application directory-sync failure')
      }
    },
  })
  const handle = kernel.issuer.issue(qualification)
  const applied = assert.rejects(kernel.adjudicator.apply(handle), { code: 'write-uncertain' })
  try {
    await Promise.race([renamed.promise, applied])
    assert.equal((await decisionRows(root))[0].envelope.record.revision, 2)
    await assert.rejects(gateway.inspect(first.operationKey), { code: 'locked' })
    await assert.rejects(kernel.adjudicator.apply(handle), { code: 'locked' })
  } finally {
    release.resolve()
    await applied
  }

  await assert.rejects(gateway.inspect(first.operationKey), { code: 'locked' })
  await assert.rejects(kernel.adjudicator.apply(handle), { code: 'locked' })
  await clearAbandonedWriterLock(join(await projectDirectory(root, 'state'), '.writer.lock'))

  const reopened = await openKernel(root, { now: () => assert.fail('applied replay sampled the clock') })
  await reopened.adjudicator.apply(reopened.issuer.issue(qualification))
  await projectedEffect(gateway)
  assert.equal((await decisionRows(root)).length, 1)
  assert.equal((await qualificationEvents(root)).length, 1)
  assert.equal(calls.handler, 1)
})

test('R3 scoped readers, durability access, and decision writers expire with the state writer', async (t) => {
  const { root, qualification } = await promotedAmbiguous(t)
  const store = await openReconciliationStore(root, qualification.projectId)
  const before = await persistedFiles(root)
  assert.deepEqual(Object.keys(store.state), ['exclusive'])
  const scoped = await store.state.exclusive(async (port) => {
    assert.ok(await port.read('action-allowance', 'task-allowance'))
    assert.equal('create' in port, false)
    assert.equal('save' in port, false)
    return port
  })
  const decision = { kind: 'action-allowance', id: 'reconciliation-' + '1'.repeat(64) }
  assert.throws(() => scoped.checksumFor('utf16-v1'), { code: 'locked' })
  await assert.rejects(scoped.read('action-allowance', 'task-allowance'), { code: 'locked' })
  await assert.rejects(scoped.list('action-allowance'), { code: 'locked' })
  await assert.rejects(scoped.syncDecisionDirectory(), { code: 'locked' })
  await assert.rejects(scoped.createDecision({ ...decision, revision: 1 }), { code: 'locked' })
  await assert.rejects(scoped.applyDecision({ ...decision, revision: 2 }), { code: 'locked' })
  assert.deepEqual(await persistedFiles(root), before)
})
