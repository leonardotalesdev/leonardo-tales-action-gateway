import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { config, first, second, third, legacyIntent, reviewedLegacy, preparedLegacy } from '../fixture.mjs'

// Run from the repository root with LANG=sv_SE.UTF-8 LC_ALL=sv_SE.UTF-8.
const release = 'a77039421f34e818f8c03c16d3be9e096c798cb3'
const locale = new Intl.Collator().resolvedOptions().locale
assert.equal(locale, 'sv-SE')
const scratch = await mkdtemp(join(tmpdir(), 'ag-v010-fixture-'))
try {
  execFileSync('tar', ['-x', '-C', scratch], {
    input: execFileSync('git', ['archive', release, 'dist', 'package.json']),
  })
  const { createActionGateway } = await import(pathToFileURL(join(scratch, 'dist/index.js')).href)
  const { computeSnapshotChecksum: hash } = await import(pathToFileURL(join(scratch, 'dist/internal/digest.js')).href)
  const directory = join(scratch, 'state-root')
  await mkdir(directory, { mode: 0o700 })
  const project = hash('project-action-' + hash(config(directory).task.id))
  const auditLock = join(directory, 'audit', project, '.writer.lock')
  const review = {}
  const gateway = await createActionGateway({
    ...config(directory),
    async review(request) {
      const { operationKey, requestId, requestDigest } = request
      review[operationKey] = { requestId, requestDigest }
      // The release writes the decision and Run transition before appending its audit entry.
      if (operationKey === reviewedLegacy.operationKey) await writeFile(auditLock, '', { flag: 'wx', mode: 0o600 })
      return operationKey === second.operationKey ? 'PENDING' : 'APPROVED'
    },
  })
  assert.equal((await gateway.execute(legacyIntent(first))).decision, 'EXECUTED')
  assert.equal((await gateway.execute(legacyIntent(second))).decision, 'APPROVAL_REQUIRED')
  assert.equal((await gateway.execute(legacyIntent({ ...third, input: { ...third.input, rows: 7 } }))).reason, 'task_limit')
  assert.equal((await gateway.execute(legacyIntent(reviewedLegacy))).reason, 'storage-or-review-failure')
  await rm(auditLock)

  // Force a read error after initial allowance registration and before proposal creation.
  const proposalPath = join(directory, 'state', project, 'proposals', hash('operation-' + hash(preparedLegacy.operationKey)) + '.json')
  await mkdir(proposalPath, { mode: 0o700 })
  await assert.rejects(gateway.execute(legacyIntent(preparedLegacy)), { code: 'unsafe-path' })
  await rm(proposalPath, { recursive: true })
  assert.ok(!review[preparedLegacy.operationKey])

  const files = {}
  const paths = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort()
  for (const path of paths) files[path.slice(directory.length + 1)] = await readFile(path, 'utf8')
  await writeFile(new URL('v0.1.0-sv-SE.json', import.meta.url),
    JSON.stringify({ release, locale, icu: process.versions.icu, review, files }, null, 2) + '\n')
} finally {
  await rm(scratch, { recursive: true })
}
