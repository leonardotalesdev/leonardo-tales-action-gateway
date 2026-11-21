import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createActionGateway } from '@leonardo-tales/action-gateway'
import { config, first, persistedFiles, projectDirectory, records, second, third, workspace } from './fixture.mjs'

const worker = new URL('./worker.mjs', import.meta.url)

async function withWriterLock(directory, check) {
  const [{ envelope: { record: { projectId } } }] = await records(directory, 'tasks')
  const path = join(await projectDirectory(directory, 'state'), '.writer.lock')
  const child = fork(worker, [directory, 'writer-lock', projectId])
  const exit = once(child, 'exit')
  try {
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(7000) })
    assert.deepEqual(message, { status: 'owns-writer-lock', manifestRevision: 1 })
    const stat = await lstat(path)
    assert.ok(stat.isFile())
    assert.equal(stat.mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { schemaVersion: 'local-writer-lock/v0.1', projectId })
    await check({ child, exit, path, stat })
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exit
  }
}

test('a separate process holding the state writer lock makes a contending Gateway refuse before review', { timeout: 15_000 }, async (t) => {
  const directory = await workspace(t)
  const options = config(directory)
  let reviews = 0
  const gateway = await createActionGateway({ ...options, review: async () => { reviews++; return 'APPROVED' } })
  assert.equal((await gateway.execute(first)).decision, 'EXECUTED')
  const settled = await gateway.execute(second)
  assert.partialDeepStrictEqual(settled, { decision: 'EXECUTED', settled: 7, held: 0, remaining: 3 })

  await withWriterLock(directory, async ({ child, exit, path, stat }) => {
    const before = await persistedFiles(directory)
    assert.deepEqual(await gateway.inspect(second.operationKey), settled)
    await assert.rejects(gateway.execute(third), { code: 'locked' })
    assert.equal(await gateway.inspect(third.operationKey), null)
    assert.equal(reviews, 2)
    assert.equal((await lstat(path)).ino, stat.ino)
    assert.deepEqual(await persistedFiles(directory), before)

    child.send('finish')
    assert.deepEqual(await exit, [0, null])
    await assert.rejects(lstat(path), { code: 'ENOENT' })
  })

  const blocked = await gateway.execute(third)
  assert.partialDeepStrictEqual(blocked, {
    decision: 'BLOCKED', reason: 'task_limit', settled: 7, held: 0, remaining: 3,
    refusalBasis: { reason: 'task_limit', cap: 10, settled: 7, held: 0, remaining: 3, requested: 4 },
  })
  assert.equal(await readFile(join(directory, 'effects'), 'utf8'), '4\n3\n')
})

test('an abandoned lock left by SIGKILL prevents writes across restart and preserves evidence', { timeout: 15_000 }, async (t) => {
  const directory = await workspace(t)
  const options = config(directory)
  let reviews = 0
  const guarded = { ...options, review: async () => { reviews++; return 'APPROVED' } }
  const gateway = await createActionGateway(guarded)
  const settled = await gateway.execute(first)
  assert.equal(settled.decision, 'EXECUTED')

  await withWriterLock(directory, async ({ child, exit, path, stat }) => {
    const before = await persistedFiles(directory)
    assert.equal(child.kill('SIGKILL'), true)
    assert.deepEqual(await exit, [null, 'SIGKILL'])

    for (const reopened of [gateway, await createActionGateway(guarded)]) {
      assert.deepEqual(await reopened.inspect(first.operationKey), settled)
      await assert.rejects(reopened.execute(first), { code: 'locked' })
      await assert.rejects(reopened.execute(second), { code: 'locked' })
      assert.equal(await reopened.inspect(second.operationKey), null)
    }
    assert.equal((await lstat(path)).ino, stat.ino)
    assert.equal(reviews, 1)
    assert.deepEqual(await persistedFiles(directory), before)
    assert.equal(await readFile(join(directory, 'effects'), 'utf8'), '4\n')
  })
})
