import assert from 'node:assert/strict'
import { chmod, link, lstat, mkdir, readFile, readlink, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createActionGateway } from '@leonardo-tales/action-gateway'
import { computeRecordEnvelopeChecksum } from '../dist/internal/digest.js'
import { createExecutionAuditStore } from '../dist/internal/execution-audit.js'
import { openLocalAuditPort } from '../dist/internal/local-store.js'
import { config, first, persistedFiles, projectDirectory, records, second, workspace } from './fixture.mjs'

function prohibitDispatch(t, options) {
  const calls = { review: 0, handler: 0 }
  t.after(() => assert.deepEqual(calls, { review: 0, handler: 0 }))
  return {
    ...options,
    review: async () => { calls.review++; return 'APPROVED' },
    tool: { ...options.tool, async execute(...args) { calls.handler++; return options.tool.execute(...args) } },
  }
}

function withChecksum({ checksum, ...body }) {
  return JSON.stringify({ ...body, checksum: computeRecordEnvelopeChecksum(body) })
}

for (const [name, corrupt] of [
  ['modified content and a stale checksum', (envelope) => {
    envelope.record.payload.expiresAt = '2030-01-01T00:01:00.000Z'
    return JSON.stringify(envelope)
  }],
  ['truncated JSON', (envelope) => JSON.stringify(envelope).slice(0, -10)],
  ['an unsupported envelope version', (envelope) =>
    withChecksum({ ...envelope, schemaVersion: 'local-record-envelope/v99' })],
  ['the wrong project with a valid checksum', (envelope) =>
    withChecksum({ ...envelope, record: { ...envelope.record, projectId: 'project-other' } })],
  ['an unsupported digest version', (envelope) =>
    withChecksum({ ...envelope, digestVersion: 'future-digest' })],
]) {
  test(`a pending approval with ${name} fails closed without rewriting any evidence`, async (t) => {
    const directory = await workspace(t)
    const options = config(directory)
    const gateway = await createActionGateway({ ...options, review: async () => 'PENDING' })
    assert.equal((await gateway.execute(first)).decision, 'APPROVAL_REQUIRED')
    const [{ path, envelope }] = await records(directory, 'approval-requests')
    await writeFile(path, corrupt(envelope))
    const before = await persistedFiles(directory)

    const reopened = await createActionGateway(prohibitDispatch(t, options))
    await assert.rejects(reopened.inspect(first.operationKey), { code: 'corrupt-record' })
    await assert.rejects(reopened.execute(first), { code: 'corrupt-record' })
    assert.deepEqual(await persistedFiles(directory), before)
  })
}

for (const [name, corrupt] of [
  ['event payload', (entry) => { entry.event.observationCode = 'changed-observation' }],
  ['event hash', (entry) => { entry.eventHash = '0'.repeat(64) }],
  ['previous hash', (entry) => { entry.previousHash = '0'.repeat(64) }],
  ['chain hash', (entry) => { entry.chainHash = '0'.repeat(64) }],
]) {
  test(`audit ${name} corruption blocks append and new dispatch, preserving existing bytes`, async (t) => {
    const directory = await workspace(t)
    const options = config(directory)
    const gateway = await createActionGateway(options)
    const settled = await gateway.execute(first)
    assert.equal(settled.decision, 'EXECUTED')
    const path = join(await projectDirectory(directory, 'audit'), 'events.jsonl')
    const originalLines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    const last = JSON.parse(originalLines.at(-1))
    assert.equal(last.previousHash, JSON.parse(originalLines.at(-2)).chainHash)
    const auditPort = await openLocalAuditPort(join(directory, 'audit'), last.event.projectId)
    const audit = createExecutionAuditStore(auditPort, last.event.projectId)
    assert.equal((await audit.read()).length, originalLines.length)
    const nextEvent = { ...last.event, id: 'test-following-observation' }

    corrupt(last)
    await writeFile(path, [...originalLines.slice(0, -1), JSON.stringify(last), ''].join('\n'))
    const before = await persistedFiles(directory)
    await assert.rejects(audit.read(), { code: 'corrupt-audit' })
    await assert.rejects(audit.append(nextEvent), { code: 'corrupt-audit' })

    const reopened = await createActionGateway(prohibitDispatch(t, options))
    assert.deepEqual(await reopened.inspect(first.operationKey), settled)
    assert.deepEqual(await reopened.execute({ ...first, runId: 'audit-damaged-retry' }), { ...settled, replayed: true })
    assert.partialDeepStrictEqual(await reopened.execute(second), {
      decision: 'BLOCKED', reason: 'storage-or-review-failure', held: 0, settled: 4, remaining: 6,
    })
    const after = await persistedFiles(directory)
    for (const [file, bytes] of Object.entries(before)) assert.deepEqual(after[file], bytes, file)
    assert.equal(await readFile(join(directory, 'effects'), 'utf8'), '4\n')
  })
}

test('group and other access to the Gateway root are refused before any state is opened', async (t) => {
  const directory = await workspace(t)
  try {
    for (const mode of [0o750, 0o705]) {
      await chmod(directory, mode)
      await assert.rejects(createActionGateway(config(directory)), { message: 'unsafe-action-gateway-directory' })
      assert.deepEqual(await persistedFiles(directory), {})
    }
  } finally {
    await chmod(directory, 0o700)
  }
})

test('a symlink in an ancestor path is rejected before opening existing state', async (t) => {
  const directory = await workspace(t)
  const parent = join(directory, 'real')
  const root = join(parent, 'gateway')
  await mkdir(parent, { mode: 0o700 })
  await mkdir(root, { mode: 0o700 })
  const gateway = await createActionGateway(config(root))
  assert.equal((await gateway.execute(first)).decision, 'EXECUTED')
  const before = await persistedFiles(root)

  const alias = join(directory, 'alias')
  await symlink(parent, alias)
  await assert.rejects(createActionGateway(config(join(alias, 'gateway'))), { code: 'unsafe-path' })
  assert.deepEqual(await persistedFiles(root), before)
})

for (const [name, replace] of [
  ['symbolic link', async (path, target) => {
    await rename(path, target)
    await symlink(target, path)
    assert.equal(await readlink(path), target)
  }],
  ['hard link', async (path, target) => {
    await link(path, target)
    assert.equal((await lstat(path)).nlink, 2)
  }],
]) {
  test(`a protected record reached through a ${name} is refused before consumption`, async (t) => {
    const directory = await workspace(t)
    const options = config(directory)
    const gateway = await createActionGateway({ ...options, review: async () => 'PENDING' })
    assert.equal((await gateway.execute(first)).decision, 'APPROVAL_REQUIRED')
    const [{ path }] = await records(directory, 'approval-requests')
    const before = await readFile(path)
    const target = join(directory, 'linked-request.json')
    await replace(path, target)
    const linked = await lstat(path)
    const priorState = await persistedFiles(directory)

    const reopened = await createActionGateway(prohibitDispatch(t, options))
    await assert.rejects(reopened.inspect(first.operationKey), { code: 'unsafe-path' })
    await assert.rejects(reopened.execute(first), { code: 'unsafe-path' })
    const after = await lstat(path)
    assert.equal(after.ino, linked.ino)
    assert.equal(after.nlink, linked.nlink)
    assert.deepEqual(await readFile(target), before)
    assert.deepEqual(await persistedFiles(directory), priorState)
    await assert.rejects(readFile(join(directory, 'effects')), { code: 'ENOENT' })
  })
}
