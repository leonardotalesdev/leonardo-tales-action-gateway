import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createActionGateway } from '../dist/index.js'
import { computeSnapshotChecksum as digest, createLegacySnapshotChecksum } from '../dist/internal/digest.js'
import { readExecutionAudit } from '../dist/internal/execution-audit.js'
import { config, first, second, third, inLocale, legacyIntent, preparedLegacy, reviewedLegacy, records, workspace } from './fixture.mjs'

// Verbatim release envelopes and audit bytes, generated from the tagged dist with Swedish ICU.
const fixture = JSON.parse(await readFile(new URL('fixtures/v0.1.0-sv-SE.json', import.meta.url), 'utf8'))
const legacyDigestLocale = fixture.locale

async function restore(t) {
  const directory = await workspace(t)
  for (const [relative, contents] of Object.entries(fixture.files)) {
    const path = join(directory, relative)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, contents, { mode: 0o600 })
  }
  return directory
}

async function effects(directory) {
  return (await readFile(join(directory, 'effects'), 'utf8')).trim().split('\n')
}

function assertReviewIdentity(request) {
  assert.deepEqual({ requestId: request.requestId, requestDigest: request.requestDigest }, fixture.review[request.operationKey])
}

test('v0.1.0 operations inspect, replay and conflict while retaining refusal and approval evidence', async (t) => {
  const directory = await restore(t)
  const gateway = await createActionGateway({ ...config(directory), legacyDigestLocale, review: async () => assert.fail('unexpected review') })
  const executed = await gateway.inspect(first.operationKey)
  assert.equal(executed.decision, 'EXECUTED')
  assert.equal(executed.evidenceId, 'effect-a')
  assert.equal(executed.approvalRequestId, fixture.review[first.operationKey].requestId)
  assert.equal(executed.inputDigest, createLegacySnapshotChecksum(legacyDigestLocale)(legacyIntent(first).input))
  assert.deepEqual(await gateway.execute({ ...legacyIntent(first), runId: 'new-run' }), { ...executed, replayed: true })
  const changed = { ...legacyIntent(first), input: { ...legacyIntent(first).input, ö: 99 } }
  assert.equal((await gateway.execute(changed)).decision, 'CONFLICT')
  const refusal = await gateway.inspect(third.operationKey)
  assert.equal(refusal.decision, 'BLOCKED')
  assert.deepEqual(refusal.refusalBasis, { reason: 'task_limit', cap: 10, settled: 4, held: 0, remaining: 6, requested: 7 })
  for (const [relative, contents] of Object.entries(fixture.files)) {
    assert.equal(await readFile(join(directory, relative), 'utf8'), contents, relative)
  }
  assert.deepEqual(await effects(directory), ['4'])
})

test('a v0.1.0 request resumes with its original ID and digest alongside new deterministic operations', async (t) => {
  const directory = await restore(t)
  const reviews = []
  const gateway = await createActionGateway({
    ...config(directory), legacyDigestLocale,
    async review(request) { reviews.push(request); return 'APPROVED' },
  })
  const pending = legacyIntent(second)
  const inspection = await gateway.inspect(second.operationKey)
  assert.equal(inspection.decision, 'APPROVAL_REQUIRED')
  assert.equal(inspection.approvalRequestId, fixture.review[second.operationKey].requestId)
  assert.equal((await gateway.execute({ ...pending, runId: 'different-run' })).reason, 'operation-bound-to-original-run')
  assert.equal(reviews.length, 0)

  const newIntent = { ...pending, runId: 'new-run', operationKey: 'new-format',
    input: { ...pending.input, rows: 2, ä: true, å: false, digestVersion: 'legacy-v0.1' } }
  const current = await gateway.execute(newIntent)
  assert.equal(current.decision, 'EXECUTED')
  assert.equal(current.inputDigest, digest(newIntent.input))
  assert.notEqual(current.inputDigest, createLegacySnapshotChecksum(legacyDigestLocale)(newIntent.input))

  const resumed = await gateway.execute(pending)
  assert.equal(resumed.decision, 'EXECUTED')
  assert.equal(resumed.settled, 9)
  assert.equal(resumed.held, 0)
  assert.equal(resumed.remaining, 1)
  assert.equal(resumed.approvalRequestId, inspection.approvalRequestId)
  assert.equal(resumed.proposalDigest, inspection.proposalDigest)
  assert.equal(reviews.length, 2)
  assertReviewIdentity(reviews[1])
  const decisions = await records(directory, 'approval-decisions')
  const captured = decisions.find(({ envelope }) => envelope.record.payload.requestId === resumed.approvalRequestId).envelope
  assert.equal(captured.schemaVersion, 'local-record-envelope/v0.2')
  assert.equal(captured.digestVersion, 'legacy-v0.1')
  assert.equal(captured.record.payload.requestDigest, reviews[1].requestDigest)
  const requests = await records(directory, 'approval-requests')
  const oldRequest = requests.find(({ envelope }) => envelope.record.id === resumed.approvalRequestId).envelope
  assert.equal(oldRequest.schemaVersion, 'local-record-envelope/v0.1')
  assert.equal(captured.record.payload.bindingDigest, createLegacySnapshotChecksum(legacyDigestLocale)(oldRequest.record.payload.binding))
  const [auditPath, originalAudit] = Object.entries(fixture.files).find(([path]) => path.endsWith('events.jsonl'))
  const updatedAudit = await readFile(join(directory, auditPath), 'utf8')
  assert.ok(updatedAudit.startsWith(originalAudit))
  assert.ok(readExecutionAudit(updatedAudit, oldRequest.record.projectId).length >
    readExecutionAudit(originalAudit, oldRequest.record.projectId).length)
  assert.deepEqual(await effects(directory), ['4', '2', '3'])
})

test('a persisted v0.1.0 approval still needs the original host endorsement before dispatch', async (t) => {
  const directory = await restore(t)
  let response = 'DENIED'
  const gateway = await createActionGateway({
    ...config(directory), legacyDigestLocale,
    async review(request) { assertReviewIdentity(request); return response },
  })
  const intent = legacyIntent(reviewedLegacy)
  const mismatch = await gateway.execute(intent)
  assert.equal(mismatch.decision, 'BLOCKED')
  assert.equal(mismatch.reason, 'invalid-approval')
  assert.deepEqual(await effects(directory), ['4'])
  response = 'APPROVED'
  assert.equal((await gateway.execute(intent)).decision, 'EXECUTED')
  assert.deepEqual(await effects(directory), ['4', '1'])
})

test('a v0.1.0 operation interrupted before proposal creation retains its original digests', async (t) => {
  const directory = await restore(t)
  const gateway = await createActionGateway({ ...config(directory), legacyDigestLocale, review: async () => 'PENDING' })
  const original = await gateway.inspect(preparedLegacy.operationKey)
  assert.equal(original.approvalRequestId, null)
  const pending = await gateway.execute(legacyIntent(preparedLegacy))
  assert.equal(pending.decision, 'APPROVAL_REQUIRED')
  assert.ok(pending.approvalRequestId)
  assert.equal(pending.inputDigest, original.inputDigest)
  assert.equal(pending.proposalDigest, original.proposalDigest)
  const reopened = await createActionGateway({ ...config(directory), legacyDigestLocale })
  assert.equal((await reopened.inspect(preparedLegacy.operationKey)).approvalRequestId, pending.approvalRequestId)
  assert.equal((await reopened.execute(legacyIntent(preparedLegacy))).decision, 'EXECUTED')
  assert.deepEqual(await effects(directory), ['4', '1'])
})

test('an expired v0.1.0 request stays blocked without review or dispatch', async (t) => {
  const directory = await restore(t)
  const gateway = await createActionGateway({
    ...config(directory), legacyDigestLocale, now: () => '2030-01-01T00:05:00.000Z',
    review: async () => assert.fail('unexpected review'),
  })
  const expired = await gateway.execute(legacyIntent(second))
  assert.equal(expired.decision, 'BLOCKED')
  assert.equal(expired.reason, 'expired')
  assert.equal(expired.approvalRequestId, fixture.review[second.operationKey].requestId)
  assert.deepEqual(await effects(directory), ['4'])
})

test('a legacy collation mismatch fails closed and a supported explicit collation restores access', async (t) => {
  const directory = await restore(t)
  const source = `
    import { createActionGateway } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}
    import { config, first } from ${JSON.stringify(new URL('./fixture.mjs', import.meta.url).href)}
    const gateway = await createActionGateway(config(${JSON.stringify(directory)}))
    const observation = await gateway.inspect(first.operationKey).then(receipt => receipt.decision, error => error.code)
    console.log(JSON.stringify([new Intl.Collator().resolvedOptions().locale, observation]))
  `
  assert.deepEqual(inLocale('sv-SE', source), ['sv-SE', 'EXECUTED'])
  assert.deepEqual(inLocale('en-US', source), ['en-US', 'corrupt-record'])
  const options = { ...config(directory), review: async () => assert.fail('unexpected review') }
  const incompatible = await createActionGateway({ ...options, legacyDigestLocale: 'en-US' })
  await assert.rejects(incompatible.inspect(first.operationKey), { code: 'corrupt-record' })
  await assert.rejects(incompatible.execute(legacyIntent(second)), { code: 'corrupt-record' })
  await assert.rejects(createActionGateway({ ...options, legacyDigestLocale: 'zz-ZZ' }), /unsupported-legacy-digest-locale/)
  const compatible = await createActionGateway({ ...options, legacyDigestLocale })
  assert.equal((await compatible.inspect(first.operationKey)).decision, 'EXECUTED')
  assert.deepEqual(await effects(directory), ['4'])
})

test('record checksum binds the digest version and linked records must agree on the version', async (t) => {
  const directory = await workspace(t)
  const gateway = await createActionGateway({ ...config(directory), review: async () => 'PENDING' })
  assert.equal((await gateway.execute(legacyIntent(first))).decision, 'APPROVAL_REQUIRED')
  const [{ envelope, path }] = await records(directory, 'approval-requests')
  const { checksum, ...body } = envelope
  assert.equal(body.digestVersion, 'utf16-v1')
  body.digestVersion = 'legacy-v0.1'
  await writeFile(path, JSON.stringify({ ...body, checksum }))
  await assert.rejects(gateway.inspect(first.operationKey), { code: 'corrupt-record' })
  await writeFile(path, JSON.stringify({ ...body, checksum: digest(body) }))
  await assert.rejects(gateway.execute(legacyIntent(first)), /approval-binding-conflict/)
  await assert.rejects(readFile(join(directory, 'effects')), { code: 'ENOENT' })
})
