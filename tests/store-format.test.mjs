import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, cp, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createActionGateway } from '../dist/index.js'
import { computeSnapshotChecksum as digest, createLegacySnapshotChecksum } from '../dist/internal/digest.js'
import { openLocalAuditPort, openLocalRecordStore } from '../dist/internal/local-store.js'
import { readReconciliationSubject } from '../dist/internal/reconciliation.js'
import { promoteTaskStore } from '../dist/internal/store-promotion.js'
import { config, first, inLocale, legacyIntent, persistedFiles, preparedLegacy, projectDirectory, records, second, workspace } from './fixture.mjs'

const task = 'case-17'
const cli = fileURLToPath(new URL('../dist/cli/promote-r2.js', import.meta.url))
const probeModule = fileURLToPath(new URL('promotion-probe.mjs', import.meta.url))
const fixture = JSON.parse(await readFile(new URL('fixtures/v0.1.0-sv-SE.json', import.meta.url), 'utf8'))

async function runCli(t, root, args = [], options = {}) {
  const log = join(await workspace(t), 'calls')
  const locale = options.ambient ?? 'en_US.UTF-8'
  const result = spawnSync(process.execPath, ['--import', probeModule, cli, '--directory', root, '--task-id', task, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', LANG: locale, LC_ALL: locale, R2_PROBE: log, ...options.env },
  })
  assert.ifError(result.error)
  const entries = (await readFile(log, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })).trim().split('\n').filter(Boolean)
  return { ...result, writes: entries.filter((entry) => !/^(collator|locale-validation) /.test(entry)),
    collators: entries.filter((entry) => entry.startsWith('collator ')) }
}

function success(result) {
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /^[a-f0-9]{64}\n$/)
  return result.stdout.trim()
}
function refusal(result, reason) {
  assert.equal(result.status, 1, result.stderr)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, reason ?? /^promotion refused:/)
}
function noWrites(result) {
  refusal(result)
  assert.deepEqual(result.writes, [])
}
async function manifest(root) {
  const row = (await records(root, 'action-allowance')).find(({ envelope }) => envelope.record.id === 'task-allowance')
  return { ...row, rel: relative(root, row.path) }
}
function recheck(envelope) {
  const { checksum, ...body } = envelope
  return { ...body, checksum: digest(body) }
}
async function writeEnvelope(path, envelope) { await writeFile(path, JSON.stringify(recheck(envelope)) + '\n') }
async function unchangedExcept(root, before, path) {
  const after = await persistedFiles(root)
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort())
  assert.notDeepEqual(after[path], before[path])
  delete before[path]
  delete after[path]
  assert.deepEqual(after, before)
}
async function legacy(t) {
  const root = await workspace(t)
  for (const [file, contents] of Object.entries(fixture.files)) {
    const path = join(root, file)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, contents, { mode: 0o600 })
  }
  return root
}
async function pending(t) {
  const root = await workspace(t)
  const gateway = await createActionGateway({ ...config(root), review: async () => 'PENDING' })
  assert.equal((await gateway.execute(first)).decision, 'APPROVAL_REQUIRED')
  return root
}
async function held(t) {
  const root = await workspace(t)
  const options = config(root)
  options.tool.execute = async () => ({ outcome: 'unknown' })
  const gateway = await createActionGateway(options)
  const receipt = await gateway.execute(first)
  assert.equal(receipt.decision, 'UNKNOWN')
  return { root, gateway, receipt }
}
async function history(root, legacyDigestLocale) {
  const { envelope: { record: { projectId } } } = await manifest(root)
  const state = await openLocalRecordStore(join(root, 'state'), projectId, { legacyDigestLocale })
  const audit = await openLocalAuditPort(join(root, 'audit'), projectId)
  return { state, audit, projectId }
}

test('deterministic promotion preserves pending approvals and all non-manifest bytes with explicit locales or no option', async (t) => {
  const base = await pending(t)
  const original = await manifest(base)
  // The wrapper retains the decoded source envelope and its checksum, even when the source was formatted differently.
  await writeFile(original.path, JSON.stringify(original.envelope, null, 2) + '\n')
  const baseline = await (await createActionGateway(config(base))).inspect(first.operationKey)
  for (const locale of [undefined, 'sv-SE', 'en-US', 'sv-SE-u-co-trad']) {
    const root = await workspace(t)
    await cp(base, root, { recursive: true })
    const before = await persistedFiles(root)
    const args = locale ? ['--legacy-digest-locale', locale] : []
    const result = await runCli(t, root, args)
    const generation = success(result)
    assert.deepEqual(result.collators, [])
    const { envelope } = await manifest(root)
    assert.equal(envelope.schemaVersion, 'local-record-envelope/v0.2')
    assert.equal(envelope.digestVersion, 'utf16-v1')
    assert.equal(envelope.record.revision, 2)
    assert.deepEqual(envelope.record.payload, {
      schemaVersion: 'action-allowance/v0.2', storeGeneration: generation, sourceManifest: original.envelope,
    })
    assert.deepEqual(envelope, recheck(envelope))
    await unchangedExcept(root, before, original.rel)

    const promoted = await persistedFiles(root)
    const repeated = await runCli(t, root, args)
    assert.equal(success(repeated), generation)
    assert.ok(repeated.writes.every((entry) => entry.endsWith('/.writer.lock')))
    assert.deepEqual(await persistedFiles(root), promoted)
    const gateway = await createActionGateway(config(root))
    assert.deepEqual(await gateway.inspect(first.operationKey), baseline)
    assert.equal(await gateway.inspect('missing'), null)
    const resumed = await gateway.execute(first)
    assert.equal(resumed.decision, 'EXECUTED')
    assert.equal(resumed.approvalRequestId, baseline.approvalRequestId)
    assert.equal((await manifest(root)).envelope.record.payload.storeGeneration, generation)
  }
})

test('sv-SE verifies the release fixture and preserves approval identities, digests, checksums and evidence', async (t) => {
  const root = await legacy(t)
  const { envelope, rel } = await manifest(root)
  const options = { ...config(root), legacyDigestLocale: 'sv-SE' }
  const beforeGateway = await createActionGateway(options)
  const beforeReceipt = await beforeGateway.inspect(first.operationKey)
  const before = await persistedFiles(root)
  const result = await runCli(t, root, ['--legacy-digest-locale', 'sv-SE'])
  const generation = success(result)
  assert.deepEqual(result.collators, ['collator sv-SE'])
  assert.deepEqual((await manifest(root)).envelope.record.payload.sourceManifest, envelope)
  await unchangedExcept(root, before, rel)
  assert.equal(success(await runCli(t, root, ['--legacy-digest-locale', 'sv-SE'])), generation)
  const gateway = await createActionGateway({
    ...options,
    async review(request) {
      assert.deepEqual({ requestId: request.requestId, requestDigest: request.requestDigest }, fixture.review[second.operationKey])
      return 'PENDING'
    },
  })
  assert.deepEqual(await gateway.inspect(first.operationKey), beforeReceipt)
  assert.equal((await gateway.execute(legacyIntent(second))).decision, 'APPROVAL_REQUIRED')
})

test('missing and wrong locales fail with zero writes even with a matching default available', async (t) => {
  const root = await legacy(t)
  const before = await persistedFiles(root)
  for (const [args, collators] of [[[], []], [['--legacy-digest-locale', 'en-US'], ['collator en-US']]]) {
    const result = await runCli(t, root, args, { ambient: 'sv_SE.UTF-8' })
    noWrites(result)
    assert.deepEqual(result.collators, collators)
    assert.deepEqual(await persistedFiles(root), before)
  }
})

test('malformed, unsupported, duplicated, missing and unknown CLI arguments are refused before any write', async (t) => {
  const root = await pending(t)
  const before = await persistedFiles(root)
  for (const args of [
    ['--legacy-digest-locale', 'sv_SE'], ['--legacy-digest-locale', 'en-US,sv-SE'],
    ['--legacy-digest-locale', 'zz-ZZ'], ['--legacy-digest-locale'],
    ['--legacy-digest-locale', 'sv-SE', '--legacy-digest-locale', 'en-US'],
    ['--handler', './never-import.mjs'], ['--review', './never-import.mjs'], ['--measure', './never-import.mjs'],
    ['--task-id', 'other'], ['--directory', root],
  ]) noWrites(await runCli(t, root, args))
  noWrites(await runCli(t, 'relative'))
  assert.deepEqual(await persistedFiles(root), before)
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../dist/cli/promote-r2.js', import.meta.url).href)})`], { encoding: 'utf8' })
  assert.equal(imported.status, 0)
  assert.equal(imported.stdout + imported.stderr, '')
})

test('mixed evidence verifies legacy bindings even inside deterministic envelopes', async (t) => {
  const root = await legacy(t)
  const gateway = await createActionGateway({ ...config(root), legacyDigestLocale: 'sv-SE', review: async () => 'PENDING' })
  await gateway.execute({ ...first, runId: 'mixed-new-run', operationKey: 'mixed-new' })
  const valid = await workspace(t)
  await cp(root, valid, { recursive: true })
  success(await runCli(t, valid, ['--legacy-digest-locale', 'sv-SE']))
  const { path, envelope } = (await records(root, 'proposals')).find((row) => !row.envelope.digestVersion)
  envelope.schemaVersion = 'local-record-envelope/v0.2'
  envelope.digestVersion = 'legacy-v0.1'
  envelope.record.payload.binding.scopeDigest = 'f'.repeat(64)
  await writeEnvelope(path, envelope)
  const before = await persistedFiles(root)
  const result = await runCli(t, root, ['--legacy-digest-locale', 'sv-SE'])
  noWrites(result)
  assert.deepEqual(result.collators, ['collator sv-SE'])
  assert.deepEqual(await persistedFiles(root), before)
})

test('promotion refuses absent stores, empty roots, other Tasks and populated projects missing a manifest', async (t) => {
  const parent = await workspace(t)
  const root = join(parent, 'missing')
  noWrites(await runCli(t, root))
  await assert.rejects(access(root), { code: 'ENOENT' })
  await mkdir(root, { mode: 0o700 })
  noWrites(await runCli(t, root))
  assert.deepEqual(await readdir(root), [])
  const options = config(root)
  options.task.id = 'other-task'
  await (await createActionGateway(options)).execute(first)
  const before = await persistedFiles(root)
  noWrites(await runCli(t, root))
  assert.deepEqual(await persistedFiles(root), before)
  const populated = await pending(t)
  await unlink((await manifest(populated)).path)
  const populatedBefore = await persistedFiles(populated)
  noWrites(await runCli(t, populated))
  assert.deepEqual(await persistedFiles(populated), populatedBefore)
})

test('both writer locks refuse promotion and the CLI never removes an existing lock', async (t) => {
  const root = await pending(t)
  for (const area of ['state', 'audit']) {
    const lock = join(await projectDirectory(root, area), '.writer.lock')
    await writeFile(lock, 'external writer')
    const before = await persistedFiles(root)
    const result = await runCli(t, root)
    noWrites(result)
    assert.match(result.stderr, /locked/)
    assert.deepEqual(await persistedFiles(root), before)
    await unlink(lock)
  }
})

test('a live execute writer and a concurrent promoter both exclude another promotion', async (t) => {
  const root = await pending(t)
  const options = config(root)
  options.tool.amount = () => {
    const result = spawnSync(process.execPath, [cli, '--directory', root, '--task-id', task], { encoding: 'utf8' })
    refusal(result, /locked/)
    return 4
  }
  options.review = async () => 'PENDING'
  await (await createActionGateway(options)).execute(first)
  const reached = Promise.withResolvers()
  const release = Promise.withResolvers()
  const firstPromotion = promoteTaskStore(root, task, undefined, {
    async checkpoint(stage) {
      if (stage === 'temporary-synced') { reached.resolve(); await release.promise }
    },
  })
  try {
    await Promise.race([reached.promise, firstPromotion.then(() => assert.fail('missing checkpoint'))])
    await assert.rejects(promoteTaskStore(root, task), { code: 'locked' })
  } finally { release.resolve() }
  const generation = await firstPromotion
  assert.equal(success(await runCli(t, root)), generation)
})

test('locked revalidation rejects changes between preflight and writer ownership', async (t) => {
  const root = await pending(t)
  const { path } = await manifest(root)
  for (const changed of [path, (await records(root, 'proposals'))[0].path, join(await projectDirectory(root, 'audit'), 'events.jsonl')]) {
    const before = await readFile(path)
    const result = await runCli(t, root, [], { env: { R2_CHANGE: changed } })
    refusal(result, /stale-revision/)
    assert.ok(result.writes.some((entry) => entry.startsWith('open-write ')))
    assert.ok(result.writes.every((entry) => entry.endsWith('/.writer.lock')))
    assert.deepEqual(await readFile(path), changed === path ? Buffer.concat([before, Buffer.from(' ')]) : before)
    // Restore an injected whitespace change on JSONL so its next preflight can validate it.
    if (changed.endsWith('events.jsonl')) await writeFile(changed, (await readFile(changed)).subarray(0, -1))
  }
})

test('an audit writer appearing after preflight blocks replacement under the state writer', async (t) => {
  const root = await pending(t)
  const lock = join(await projectDirectory(root, 'audit'), '.writer.lock')
  const before = await persistedFiles(root)
  const result = await runCli(t, root, [], { env: { R2_ADD_AUDIT_LOCK: lock } })
  refusal(result, /locked/)
  assert.equal(await readFile(lock, 'utf8'), 'audit writer')
  assert.ok(result.writes.every((entry) => entry.endsWith('/.writer.lock')))
  await unlink(lock)
  assert.deepEqual(await persistedFiles(root), before)
})

const crashCases = [
  ['lock-owned', 1, false, false], ['before-temp', 1, false, false],
  ['partial-temp', 1, true, false], ['temp-synced', 1, true, false],
  ['renamed', 2, false, false], ['directory-synced', 2, false, false],
  ['before-stdout', 2, false, true],
]
for (const [stage, revision, leavesTemp, releasesLock] of crashCases) {
  test(`process death at ${stage} leaves one canonical manifest and never adopts a temporary file`, async (t) => {
    const root = await pending(t)
    const { path, envelope: original } = await manifest(root)
    const result = await runCli(t, root, [], { env: { R2_FAULT: stage, R2_MANIFEST: path } })
    assert.equal(result.signal, 'SIGKILL', result.stderr)
    assert.equal(result.stdout, '')
    const { envelope } = await manifest(root)
    assert.equal(envelope.record.revision, revision)
    if (revision === 1) assert.deepEqual(envelope, original)
    const temporary = (await readdir(dirname(path))).find((name) => name.includes('.tmp-'))
    assert.equal(Boolean(temporary), leavesTemp)
    const partial = temporary && await readFile(join(dirname(path), temporary))
    const lock = join(await projectDirectory(root, 'state'), '.writer.lock')
    if (!releasesLock) {
      const lockBytes = await readFile(lock)
      const refused = await runCli(t, root)
      noWrites(refused)
      assert.match(refused.stderr, /locked/)
      assert.deepEqual(await readFile(lock), lockBytes)
      // The fixture owns the dead child and keeps the maintenance fence.
      await unlink(lock)
    } else await assert.rejects(access(lock), { code: 'ENOENT' })
    const generation = success(await runCli(t, root))
    if (revision === 2) assert.equal(generation, envelope.record.payload.storeGeneration)
    if (temporary) {
      assert.deepEqual(await readFile(join(dirname(path), temporary)), partial)
      if (stage === 'temp-synced') assert.notEqual(generation, JSON.parse(partial).record.payload.storeGeneration)
    }
    assert.equal(success(await runCli(t, root)), generation)
  })
}

test('directory sync failure returns write-uncertain, keeps the writer lock and leaves stdout empty', async (t) => {
  const root = await pending(t)
  const { path } = await manifest(root)
  const result = await runCli(t, root, [], { env: { R2_FAULT: 'uncertain', R2_MANIFEST: path } })
  refusal(result, /write-uncertain/)
  const installed = await manifest(root)
  const lock = join(await projectDirectory(root, 'state'), '.writer.lock')
  await access(lock)
  noWrites(await runCli(t, root))
  await unlink(lock) // The child has exited and the fixture maintains the fence.
  assert.equal(success(await runCli(t, root)), installed.envelope.record.payload.storeGeneration)
})

test('R1 golden identity, stale pre-promotion token, independent lineage and copy/rollback limits', async (t) => {
  const { root, gateway, receipt } = await held(t)
  const { state, audit, projectId } = await history(root)
  const read = () => readReconciliationSubject(state, audit, projectId, first.operationKey)
  const original = await read()
  assert.equal(original.observedPrefix, 'reconciliation-required')
  assert.equal(original.subjectDigest, 'df1c712f8a5d5348ee89719bd995eb695c0eba28805d47f59b1c72754ee19624')
  assert.equal(original.expectedState, '19ab8ceeb6685a7d3d5bde5fbf150145f57db954cb8c928073cae72eac0719cd')
  const independent = await workspace(t)
  await cp(root, independent, { recursive: true })
  const { path, rel } = await manifest(root)
  const before = await persistedFiles(root)
  const originalManifest = before[rel]
  const firstGeneration = success(await runCli(t, root))
  const secondGeneration = success(await runCli(t, independent))
  assert.notEqual(firstGeneration, secondGeneration)
  await unchangedExcept(root, before, rel)
  const after = await read()
  assert.deepEqual(after.subject, original.subject)
  assert.equal(after.subjectDigest, original.subjectDigest)
  assert.equal(after.expectedState, digest({
    domain: 'action-gateway/reconciliation-state/v2', manifestRevision: 2,
    storeGeneration: firstGeneration, historicalState: original.expectedState,
  }))
  assert.notEqual(after.expectedState, original.expectedState)
  const promotedManifest = (await manifest(root)).envelope
  function reverseKeys(value) {
    if (Array.isArray(value)) return value.map(reverseKeys)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]))
    }
    return value
  }
  await writeFile(path, JSON.stringify(reverseKeys(promotedManifest)) + '\n')
  for (const locale of ['en-US', 'sv-SE']) {
    const observed = inLocale(locale, `
      import { join } from 'node:path'
      import { openLocalRecordStore, openLocalAuditPort } from ${JSON.stringify(new URL('../dist/internal/local-store.js', import.meta.url).href)}
      import { readReconciliationSubject } from ${JSON.stringify(new URL('../dist/internal/reconciliation.js', import.meta.url).href)}
      const root = ${JSON.stringify(root)}
      const projectId = ${JSON.stringify(projectId)}
      const state = await openLocalRecordStore(join(root, 'state'), projectId)
      const audit = await openLocalAuditPort(join(root, 'audit'), projectId)
      console.log(JSON.stringify(await readReconciliationSubject(state, audit, projectId, ${JSON.stringify(first.operationKey)})))
    `)
    assert.deepEqual(observed, JSON.parse(JSON.stringify(after)))
  }

  const copied = await workspace(t)
  await cp(root, copied, { recursive: true })
  const copy = await history(copied)
  assert.deepEqual(await readReconciliationSubject(copy.state, copy.audit, copy.projectId, first.operationKey), after)
  assert.equal(success(await runCli(t, copied)), firstGeneration)
  const other = await history(independent)
  assert.notEqual((await readReconciliationSubject(other.state, other.audit, other.projectId, first.operationKey)).expectedState, after.expectedState)
  assert.deepEqual(await gateway.inspect(first.operationKey), receipt)
  await gateway.execute(second)
  assert.deepEqual(await read(), after)
  const { envelope } = await manifest(root)
  envelope.record.payload.storeGeneration = 'd'.repeat(64)
  await writeEnvelope(path, envelope)
  assert.notEqual((await read()).expectedState, after.expectedState)
  await writeFile(path, originalManifest)
  assert.deepEqual(await read(), original)
})

test('R1 refuses an overlapping manifest change and normal inspect sees consistent data on each side of rename', async (t) => {
  const { root, gateway, receipt } = await held(t)
  const { state, audit, projectId } = await history(root)
  const baseline = await readReconciliationSubject(state, audit, projectId, first.operationKey)
  const wrappedAudit = { async read() {
    const bytes = await audit.read()
    await promoteTaskStore(root, task)
    return bytes
  } }
  assert.deepEqual(await readReconciliationSubject(state, wrappedAudit, projectId, first.operationKey),
    { status: 'ineligible', reason: 'invalid-history' })
  const alreadyPromoted = await readReconciliationSubject(state, audit, projectId, first.operationKey)
  assert.notEqual(alreadyPromoted.expectedState, baseline.expectedState)

  const other = await held(t)
  const observed = []
  await promoteTaskStore(other.root, task, undefined, { async checkpoint(stage) {
    if (stage !== 'directory-synced') observed.push({ stage, receipt: await other.gateway.inspect(first.operationKey) })
  } })
  assert.deepEqual(observed, [
    { stage: 'temporary-synced', receipt }, { stage: 'renamed', receipt },
  ])
})

test('corrupt, nested, future and identity-mismatched manifests fail closed even for missing-key inspection', async (t) => {
  const { root, gateway } = await held(t)
  await promoteTaskStore(root, task)
  const { path, envelope: valid } = await manifest(root)
  for (const [label, mutate] of [
    ['future revision', (e) => e.record.revision++],
    ['extra wrapper field', (e) => e.record.payload.extra = true],
    ['missing wrapper field', (e) => delete e.record.payload.sourceManifest],
    ['wrong wrapper format', (e) => e.record.payload.schemaVersion = 'action-allowance/v0.3'],
    ['wrong project', (e) => e.record.projectId = 'project-other'],
    ['wrong kind', (e) => e.record.kind = 'tasks'],
    ['wrong ID', (e) => e.record.id = 'unrelated'],
    ['nested', (e) => e.record.payload.sourceManifest = structuredClone(valid)],
    ['uppercase generation', (e) => e.record.payload.storeGeneration = 'A'.repeat(64)],
    ['short generation', (e) => e.record.payload.storeGeneration = 'b'.repeat(63)],
    ['zero generation', (e) => e.record.payload.storeGeneration = '0'.repeat(64)],
    ['historical checksum', (e) => e.record.payload.sourceManifest.checksum = 'b'.repeat(64)],
    ['unsupported digest version', (e) => e.digestVersion = 'utf16-v2'],
    ['incompatible outer digest version', (e) => e.digestVersion = 'legacy-v0.1'],
    ['unsupported envelope version', (e) => e.schemaVersion = 'local-record-envelope/v0.3'],
    ['inner identity mismatch', (e) => {
      e.record.payload.sourceManifest.record.id = 'different-manifest'
      e.record.payload.sourceManifest = recheck(e.record.payload.sourceManifest)
    }],
    ['malformed historical configuration', (e) => {
      e.record.payload.sourceManifest.record.payload.task.cap = 0
      e.record.payload.sourceManifest = recheck(e.record.payload.sourceManifest)
    }],
  ]) {
    const copy = structuredClone(valid)
    mutate(copy)
    await writeEnvelope(path, copy)
    await assert.rejects(gateway.inspect('missing'), undefined, label)
    await assert.rejects(gateway.inspect(first.operationKey), undefined, label)
    const result = await runCli(t, root)
    noWrites(result)
  }
})

test('an offline store with the R1 reserved prefix preserves its subject and ambiguous hold across promotion', async (t) => {
  const root = await workspace(t)
  const worker = fileURLToPath(new URL('worker.mjs', import.meta.url))
  const processResult = spawnSync(process.execPath, [worker, root, 'crash'], { encoding: 'utf8' })
  assert.equal(processResult.status, 77, processResult.stderr)
  const { state, audit, projectId } = await history(root)
  const get = () => readReconciliationSubject(state, audit, projectId, first.operationKey)
  const original = await get()
  assert.equal(original.observedPrefix, 'reserved')
  const { rel } = await manifest(root)
  const before = await persistedFiles(root)
  const generation = success(await runCli(t, root))
  await unchangedExcept(root, before, rel)
  const result = await get()
  assert.equal(result.observedPrefix, 'reserved')
  assert.deepEqual(result.subject, original.subject)
  assert.equal(result.subjectDigest, original.subjectDigest)
  assert.equal(result.expectedState, digest({
    domain: 'action-gateway/reconciliation-state/v2', manifestRevision: 2,
    storeGeneration: generation, historicalState: original.expectedState,
  }))
  const options = config(root)
  options.tool.execute = async () => assert.fail('reserved operation dispatched again')
  const gateway = await createActionGateway(options)
  assert.partialDeepStrictEqual(await gateway.inspect(first.operationKey), { decision: 'UNKNOWN', held: 4, settled: 0, remaining: 6 })
  assert.equal(await readFile(join(root, 'effects'), 'utf8'), '4\n')
})

test('promotion rejects execution records for pending or blocked operations and invalid execution timestamps', async (t) => {
  const { root: base } = await held(t)
  for (const inconsistency of ['pending', 'blocked', 'before Run creation', 'after attempt creation']) {
    await t.test(inconsistency, async (st) => {
      const root = await workspace(st)
      await cp(base, root, { recursive: true })
      const [{ path: attemptPath }] = await records(root, 'gateway-attempts')
      if (inconsistency === 'pending' || inconsistency === 'blocked') {
        // Isolate the execution record. An attempt on these phases is already refused separately.
        await unlink(attemptPath)
        const { path, envelope } = (await records(root, 'action-allowance'))
          .find(({ envelope }) => envelope.record.payload.key === first.operationKey)
        envelope.record.payload.phase = inconsistency
        if (inconsistency === 'pending') {
          envelope.record.revision = 1
          envelope.record.payload.binding = null
        }
        await writeEnvelope(path, envelope)
      } else {
        const [{ path, envelope }] = await records(root, 'execution')
        const time = inconsistency === 'before Run creation' ? '2029-12-31T23:59:59.000Z' : '2030-01-01T00:00:01.000Z'
        envelope.record.payload.createdAt = time
        envelope.record.payload.updatedAt = time
        await writeEnvelope(path, envelope)
      }
      const before = await persistedFiles(root)
      noWrites(await runCli(st, root))
      assert.deepEqual(await persistedFiles(root), before)
    })
  }
})

test('promotion uses runtime allowance totals for below-cap, exact-cap, and released capacity', async (t) => {
  for (const [label, firstRows, firstOutcome, secondRows, expected] of [
    ['below cap', 4, 'unknown', 3, { settled: 3, held: 4, remaining: 3 }],
    ['exact cap', 4, 'unknown', 6, { settled: 6, held: 4, remaining: 0 }],
    ['confirmed no-effect releases capacity', 7, 'no-effect', 4, { settled: 4, held: 0, remaining: 6 }],
  ]) {
    await t.test(label, async (st) => {
      const root = await workspace(st)
      const options = config(root)
      options.tool.execute = async (input) => ({ outcome: input.batch === first.input.batch ? firstOutcome : 'executed',
        evidenceId: 'allowance-test-evidence' })
      const gateway = await createActionGateway(options)
      await gateway.execute({ ...first, input: { ...first.input, rows: firstRows } })
      const settled = await gateway.execute({ ...second, input: { ...second.input, rows: secondRows } })
      assert.equal(settled.decision, 'EXECUTED')
      assert.partialDeepStrictEqual(settled, expected)
      const before = await persistedFiles(root)
      success(await runCli(st, root))
      await unchangedExcept(root, before, (await manifest(root)).rel)
      assert.partialDeepStrictEqual(await gateway.inspect(second.operationKey), expected)
    })
  }
})

test('promotion refuses an aggregate above cap before writing even when individual records verify', async (t) => {
  const root = await workspace(t)
  const options = config(root)
  options.tool.execute = async (input) => ({ outcome: input.batch === first.input.batch ? 'no-effect' : 'executed',
    evidenceId: 'allowance-test-evidence' })
  const gateway = await createActionGateway(options)
  await gateway.execute({ ...first, input: { ...first.input, rows: 7 } })
  assert.equal((await gateway.execute({ ...second, input: { ...second.input, rows: 4 } })).decision, 'EXECUTED')

  const { path, envelope } = (await records(root, 'gateway-attempts'))
    .find(({ envelope }) => envelope.record.payload.result.effect === 'not-performed')
  envelope.record.payload.result = { status: 'confirmed-success', evidenceRef: envelope.record.payload.result.evidenceRef }
  await writeEnvelope(path, envelope)
  const execution = (await records(root, 'execution')).find((row) => row.envelope.record.id === envelope.record.id)
  execution.envelope.record.payload.status = 'executed'
  await writeEnvelope(execution.path, execution.envelope)
  await assert.rejects(gateway.inspect(first.operationKey), /task-allowance-inconsistent/)

  const before = await persistedFiles(root)
  noWrites(await runCli(t, root))
  assert.deepEqual(await persistedFiles(root), before)
})

test('regional locales promote an existing store with a legacy manifest', async (t) => {
  const base = await pending(t)
  const original = await manifest(base)
  for (const locale of [
    'en-US', 'en-GB', 'en-AU', 'en-CA', 'es-ES', 'es-MX', 'es-AR', 'pt-BR', 'pt-PT',
    'de-DE', 'de-AT', 'de-CH', 'fr-FR', 'fr-CA', 'fr-CH', 'sv-SE', 'tr-TR', 'ja-JP',
    'ko-KR', 'zh-Hans-CN', 'zh-Hant-TW', 'sr-Cyrl-RS', 'sr-Latn-RS', 'nb-NO', 'da-DK', 'SV-se',
    'sv-SE-u-co-trad', 'de-DE-u-co-phonebk', 'es-ES-u-co-trad', 'zh-Hans-CN-u-co-pinyin',
    'sv-SE-u-co-phonebk',
  ]) {
    await t.test(locale, async (st) => {
      const root = await workspace(st)
      await cp(base, root, { recursive: true })
      const requested = new Intl.Locale(locale)
      if (requested.collation) {
        const resolved = new Intl.Locale(new Intl.Collator(locale).resolvedOptions().locale)
        if (requested.collation !== resolved.collation) {
          const before = await persistedFiles(root)
          const result = await runCli(st, root, ['--legacy-digest-locale', locale])
          noWrites(result)
          assert.match(result.stderr, /invalid or unsupported legacy digest locale/)
          assert.deepEqual(result.collators, [])
          assert.deepEqual(await persistedFiles(root), before)
          return
        }
      }

      const { record } = original.envelope
      const source = { schemaVersion: 'local-record-envelope/v0.1', record, checksum: createLegacySnapshotChecksum(locale)(record) }
      await writeFile(join(root, original.rel), JSON.stringify(source) + '\n')
      const before = await persistedFiles(root)
      const result = await runCli(st, root, ['--legacy-digest-locale', locale])
      const generation = success(result)
      assert.deepEqual(result.collators, ['collator ' + locale])
      const { envelope } = await manifest(root)
      assert.equal(envelope.record.revision, 2)
      assert.equal(envelope.record.payload.storeGeneration, generation)
      assert.deepEqual(envelope.record.payload.sourceManifest, source)
      await unchangedExcept(root, before, original.rel)
    })
  }
})

test('explicit locale rejects requests that ICU cannot preserve, before any writes', async (t) => {
  const root = await pending(t)
  const before = await persistedFiles(root)
  for (const locale of [
    'sv-SE-u-co-bogus', 'sv-SE-u-co-trad-co-bogus', 'sv-SE-u-kn-true-kn-false', 'sv-SE-u-nu-latn',
    'sv-SE-x-private', 'en-ZZ', 'zz-ZZ', 'en-Qaaa-US', 'en_US', 'sv--SE', '',
  ]) {
    const result = await runCli(t, root, ['--legacy-digest-locale', locale])
    noWrites(result)
    assert.match(result.stderr, locale ? /invalid or unsupported legacy digest locale/ : /invalid arguments/)
    assert.deepEqual(result.collators, [])
    assert.deepEqual(await persistedFiles(root), before)
  }
})

test('pre-proposal legacy pending history promotes but still requires matching input to resume', async (t) => {
  const root = await legacy(t)
  const { state, audit, projectId } = await history(root, 'sv-SE')
  const operation = (await records(root, 'action-allowance'))
    .find(({ envelope }) => envelope.record.payload.key === preparedLegacy.operationKey)
  const proposalPath = join(dirname(operation.path), '..', 'proposals', digest(operation.envelope.record.id) + '.json')
  await assert.rejects(access(proposalPath), { code: 'ENOENT' })
  assert.equal(operation.envelope.record.payload.phase, 'pending')

  const before = await persistedFiles(root)
  success(await runCli(t, root, ['--legacy-digest-locale', 'sv-SE']))
  await unchangedExcept(root, before, (await manifest(root)).rel)
  assert.deepEqual(await readReconciliationSubject(state, audit, projectId, preparedLegacy.operationKey),
    { status: 'ineligible', reason: 'not-held' })

  const gateway = await createActionGateway({ ...config(root), legacyDigestLocale: 'sv-SE' })
  const input = legacyIntent(preparedLegacy)
  const promoted = await persistedFiles(root)
  assert.equal((await gateway.execute({ ...input, input: { ...input.input, rows: 2 } })).decision, 'CONFLICT')
  assert.deepEqual(await persistedFiles(root), promoted)
  const resumed = await gateway.execute(input)
  assert.equal(resumed.decision, 'EXECUTED')
  assert.equal(resumed.inputDigest, operation.envelope.record.payload.inputDigest)
  assert.equal(resumed.proposalDigest, operation.envelope.record.payload.proposalDigest)
})

test('held history without its proposal refuses promotion before any writes', async (t) => {
  const { root } = await held(t)
  const [{ path }] = await records(root, 'proposals')
  await unlink(path)
  const before = await persistedFiles(root)
  noWrites(await runCli(t, root))
  assert.deepEqual(await persistedFiles(root), before)
})
