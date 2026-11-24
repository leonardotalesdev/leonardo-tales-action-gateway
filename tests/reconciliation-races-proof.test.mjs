import assert from 'node:assert/strict'
import { lstat } from 'node:fs/promises'
import test from 'node:test'
import { first, persistedFiles, records } from './fixture.mjs'
import { makeQualification } from './reconciliation-decision-fixture.mjs'
import {
  allowance, assertDecision, assertEntries, assertOnlyDecisionAndEventChanged, prepareAmbiguous, proofRequest, proofScope, proofTimeout, writerPath,
} from './reconciliation-process-proof-fixture.mjs'

const effect = 'confirmed-effect'
const noEffect = 'confirmed-no-effect'
const otherRequest = { ...proofRequest, requestId: 'another-reconciliation' }
const busy = { status: 'refused', code: 'store-busy' }

function checkAssessment({ context, assessment }, qualification) {
  const { requestId, actorId, evidenceRef, subjectDigest, expectedState,
    evidenceDigest, qualifiedAt, outcome, proof } = qualification
  assert.partialDeepStrictEqual(context, {
    requestId, actorId, evidenceRef,
    subject: {
      projectId: qualification.projectId,
      taskId: qualification.taskId,
      operationKey: qualification.operationKey,
      attemptId: qualification.attemptId,
      executionIdentity: qualification.executionIdentity,
      storeGeneration: qualification.storeGeneration,
      observedPrefix: 'reconciliation-required',
      subjectDigest, expectedState,
    },
  })
  assert.deepEqual(assessment, {
    status: outcome, qualifiedAt, evidenceDigest,
    binding: { requestId, actorId, evidenceRef, subjectDigest, expectedState },
    ...proof,
  })
}

function receiptFor(status, request, outcome) {
  return { status, ...request, outcome: outcome === effect ? 'reconciled-effect' : 'reconciled-no-effect' }
}

const races = [
  ['four identical confirmed-effect assessments', [effect, effect, effect, effect]],
  ['four identical confirmed-no-effect assessments', [noEffect, noEffect, noEffect, noEffect]],
  ['opposing assessments for the same request', [effect, noEffect]],
  ['different requests for the same attempt', [effect, effect], otherRequest],
]

async function proveRace(scope, outcomes, rivalRequest) {
  const { root } = scope
  const { gateway, subject, generation } = await prepareAmbiguous(scope)
  const original = await persistedFiles(root)
  const stateLock = await writerPath(root)
  const auditLock = await writerPath(root, 'audit')
  const rows = (await records(root, 'action-allowance')).map(({ envelope }) => envelope.record)
  assert.equal(rows.length, 2, 'the manifest and original operation are the only initial allowance rows')
  const manifest = rows.find(({ id }) => id === 'task-allowance')
  const operation = rows.find(({ payload }) => payload.key === first.operationKey)
  assert.equal(manifest.payload.storeGeneration, generation)
  assert.equal(operation.payload.phase, 'held')
  const { cap } = manifest.payload.sourceManifest.record.payload.task
  const { amount } = operation.payload
  assert.deepEqual([cap, amount], [10, 4])
  const held = [amount, 0, cap - amount]
  assert.deepEqual(await allowance(gateway), held)
  await assertEntries(scope, [first])

  const contenders = []
  for (const [index, outcome] of outcomes.entries()) {
    const request = index === 0 ? proofRequest : rivalRequest
    const qualification = makeQualification(subject, generation, outcome, { requestId: request.requestId })
    // Stage observation serially because it also uses the fail-fast state writer.
    // Each complete assessment stays suspended until the common application release.
    const worker = await scope.start({ request, outcome, pauseClock: 1 })
    worker.send({ type: 'start' })
    checkAssessment(await worker.next('assessed'), qualification)
    contenders.push({ worker, request, outcome, qualification })
  }
  assert.ok(contenders.every(({ worker }) => Number.isInteger(worker.pid) && worker.pid !== process.pid))
  assert.equal(new Set(contenders.map(({ worker }) => worker.pid)).size, outcomes.length)
  await assertDecision(root, { revision: 0, eventCount: 0 })
  assert.deepEqual(await persistedFiles(root), original)

  const epoch = 1
  const owner = Promise.any(contenders.map(async (contender) => {
    await contender.worker.next('writer-held')
    return contender
  }))
  for (const { worker } of contenders) worker.send({ type: 'release', epoch })
  const winner = await owner
  for (const { worker } of contenders) assert.equal((await worker.next('released')).epoch, epoch)

  const lock = await lstat(stateLock)
  assert.ok(lock.isFile())
  assert.equal(lock.mode & 0o777, 0o600)
  await assert.rejects(lstat(auditLock), { code: 'ENOENT' })
  // No reconciliation row exists yet. An inspection can still see the old hold,
  // while a normal execute must acquire the real state writer and fail busy.
  assert.deepEqual(await allowance(gateway), held)
  await assert.rejects(gateway.execute(first), { code: 'locked' })
  for (const contender of contenders) {
    if (contender === winner) continue
    // This caller already passed preflight and completed resolution. With the owner
    // still blocked at the first R3 clock sample, busy came from the application lock.
    assert.deepEqual(await contender.worker.result(), {
      receipt: busy, resolverCalls: 1, clockCalls: 0, installs: [],
    })
  }
  const stillHeld = await lstat(stateLock)
  assert.deepEqual([stillHeld.dev, stillHeld.ino], [lock.dev, lock.ino])
  await assertDecision(root, { revision: 0, eventCount: 0 })
  winner.worker.releaseWriter()
  assert.deepEqual(await winner.worker.result(), {
    receipt: receiptFor('applied', winner.request, winner.outcome),
    resolverCalls: 1, clockCalls: 2, installs: [1, 2],
  })
  await assert.rejects(lstat(stateLock), { code: 'ENOENT' })
  await assert.rejects(lstat(auditLock), { code: 'ENOENT' })
  await assertDecision(root, { revision: 2, eventCount: 1, qualification: winner.qualification })

  const totals = winner.outcome === effect ? [0, amount, cap - amount] : [0, 0, cap]
  assert.deepEqual(await allowance(gateway), totals)
  const applied = await persistedFiles(root)
  await assertOnlyDecisionAndEventChanged(root, original, applied)
  await assertEntries(scope, [first])

  for (const { request, outcome } of contenders) {
    const fresh = await scope.start({ request, outcome, failResolver: true, failClock: true })
    fresh.send({ type: 'start' })
    const exact = request.requestId === winner.request.requestId
    const expected = exact ? receiptFor('replayed', winner.request, winner.outcome)
      : { status: 'refused', code: 'attempt-conflict' }
    // Fresh exact public replay checks the durable binding and never considers a contrary
    // resolver. The preserved ordered R4 race covers the in-flight opposing assessment.
    assert.deepEqual(await fresh.result(), {
      receipt: expected, resolverCalls: 0, clockCalls: 0, installs: [],
    })
  }
  assert.partialDeepStrictEqual(await gateway.execute(first), {
    reason: receiptFor('replayed', winner.request, winner.outcome).outcome, replayed: true,
  })
  assert.deepEqual(await persistedFiles(root), applied)
  assert.deepEqual(await allowance(gateway), totals)
  await assertEntries(scope, [first])
}

for (const [name, outcomes, rivalRequest = proofRequest] of races) {
  test(`R5 common release contends at the real application writer for ${name}`, { timeout: proofTimeout }, async (t) => {
    const scope = await proofScope(t)
    try {
      await proveRace(scope, outcomes, rivalRequest)
    } finally {
      await scope.close()
    }
  })
}
