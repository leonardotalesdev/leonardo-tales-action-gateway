import assert from 'node:assert/strict'
import { lstat } from 'node:fs/promises'
import { relative } from 'node:path'
import test from 'node:test'
import { createActionGateway } from '../dist/index.js'
import { first, persistedFiles, records, second } from './fixture.mjs'
import { installInterruptedPrefix, journal, makeQualification, readSubject, startNative } from './reconciliation-decision-fixture.mjs'
import {
  allowance, assertDecision, assertEntries, prepareAmbiguous, proofConfig, proofRequest, proofScope, proofTimeout,
  recordEntry, writerPath,
} from './reconciliation-process-proof-fixture.mjs'

const coexistenceWorker = new URL('./reconciliation-coexistence-worker.mjs', import.meta.url)
const bounds = { timeout: proofTimeout }

async function pauseWithAssessment(scope, subject, generation, options) {
  const worker = await scope.start(options)
  worker.send({ type: 'start' })
  const { context } = await worker.next('assessed')
  assert.partialDeepStrictEqual(context.subject, {
    operationKey: first.operationKey, storeGeneration: generation,
    subjectDigest: subject.subjectDigest, expectedState: subject.expectedState,
  })
  return worker
}

async function completeConcurrently(scope, reconciling, role, resultType) {
  const worker = await scope.spawn(coexistenceWorker, [scope.root, scope.entryLog, role])
  assert.notEqual(worker.pid, reconciling.pid)
  const result = await worker.next(resultType)
  assert.deepEqual(await worker.waitExit(), { code: 0, signal: null })
  return result
}

async function operationHistory(root, operationKey) {
  const operation = (await records(root, 'action-allowance')).find(
    ({ envelope }) => envelope.record.payload.key === operationKey).envelope.record
  const { executionId, runId } = operation.payload.binding
  const [run, attempt, execution] = await Promise.all([
    ['runs', runId], ['gateway-attempts', executionId], ['execution', executionId],
  ].map(async ([kind, id]) => (await records(root, kind)).find(
    ({ envelope }) => envelope.record.id === id).envelope.record))
  return { operation, run, attempt, execution }
}

test('R5 refuses an assessment after another process commits a valid bound Run extension', bounds, async (t) => {
  const scope = await proofScope(t)
  try {
    const { root } = scope
    const { gateway, subject, generation } = await prepareAmbiguous(scope)
    const runId = subject.subject.binding.runId
    const reconciling = await pauseWithAssessment(scope, subject, generation)
    const before = await persistedFiles(root)
    const extension = await completeConcurrently(scope, reconciling, 'extend-run', 'run-extended')
    assert.equal(extension.runId, runId)
    const afterExtension = await persistedFiles(root)
    const run = (await records(root, 'runs')).find(({ envelope }) => envelope.record.id === runId)
    assert.partialDeepStrictEqual(run.envelope.record, { revision: extension.revision, payload: { status: 'paused' } })
    const runPath = relative(root, run.path)
    assert.notDeepEqual(afterExtension[runPath], before[runPath])
    assert.deepEqual(afterExtension, { ...before, [runPath]: afterExtension[runPath] })
    assert.deepEqual(await allowance(gateway), [4, 0, 6])

    reconciling.send({ type: 'release', epoch: 1 })
    const { receipt, resolverCalls } = await reconciling.result()
    assert.deepEqual(receipt, { status: 'refused', code: 'ineligible' })
    assert.equal(resolverCalls, 1)
    await assertDecision(root, { revision: 0, eventCount: 0 })
    assert.deepEqual(await persistedFiles(root), afterExtension)
    assert.deepEqual(await allowance(gateway), [4, 0, 6])
    await assertEntries(scope, [first])
  } finally {
    await scope.close()
  }
})

test('R5 another process uses both writers and completes unrelated work during suspended resolution', bounds, async (t) => {
  const scope = await proofScope(t)
  try {
    const { root } = scope
    const { gateway, subject, generation, qualification } = await prepareAmbiguous(scope)
    const reconciling = await pauseWithAssessment(scope, subject, generation)
    const before = await journal(root)
    const original = await operationHistory(root, first.operationKey)
    const { receipt: unrelated } = await completeConcurrently(scope, reconciling, 'unrelated-operation', 'unrelated-finished')
    assert.partialDeepStrictEqual(unrelated, { decision: 'EXECUTED', operationKey: second.operationKey,
      held: 4, settled: 3, remaining: 3, replayed: false })
    const during = await journal(root)
    assert.deepEqual(during.slice(0, before.length), before)
    assert.ok(during.length > before.length)
    const unchanged = await readSubject(root)
    assert.equal(unchanged.expectedState, subject.expectedState)
    assert.equal(unchanged.subjectDigest, subject.subjectDigest)
    assert.deepEqual(await operationHistory(root, first.operationKey), original)
    const completed = await operationHistory(root, second.operationKey)
    assert.equal(completed.operation.payload.amount, 3)
    assert.partialDeepStrictEqual(completed.attempt.payload, { phase: 'closed', result: { status: 'confirmed-success' } })
    assert.equal(completed.execution.payload.status, 'executed')
    await assertDecision(root, { revision: 0, eventCount: 0 })
    assert.deepEqual(await allowance(gateway), [4, 3, 3])
    await assertEntries(scope, [first, second])

    reconciling.send({ type: 'release', epoch: 1 })
    assert.partialDeepStrictEqual(await reconciling.result(), {
      receipt: { status: 'applied', ...proofRequest, outcome: 'reconciled-effect' }, resolverCalls: 1,
    })
    await assertDecision(root, { revision: 2, qualification, eventCount: 1 })
    const after = await journal(root)
    assert.deepEqual(after.slice(0, -1), during)
    assert.deepEqual(await operationHistory(root, first.operationKey), original)
    assert.deepEqual(await operationHistory(root, second.operationKey), completed)
    assert.deepEqual(await allowance(gateway), [0, 7, 3])
    assert.deepEqual(await allowance(gateway, second.operationKey), [0, 7, 3])
    await assertEntries(scope, [first, second])
  } finally {
    await scope.close()
  }
})

for (const liveWriter of [true, false]) {
  const boundary = liveWriter ? 'while the reconciliation writer is held' : 'after opposing revision 2 is applied and unlocked'
  test(`R5 a late native success cannot close ${boundary}`, bounds, async (t) => {
    const scope = await proofScope(t)
    const { root, entryLog } = scope
    const entered = Promise.withResolvers()
    const continuation = Promise.withResolvers()
    let execution
    try {
      const history = await startNative(root, {
        resolve: () => entered.resolve(recordEntry(entryLog, first.operationKey, history.binding.executionId)),
      }, continuation)
      execution = history.native.execute(history.proposalId)
      await Promise.race([entered.promise, execution.then((receipt) => assert.fail(JSON.stringify(receipt)))])
      await assertEntries(scope, [first])
      await installInterruptedPrefix(history)
      const unresolved = await readSubject(root)
      assert.equal(unresolved.observedPrefix, 'reconciliation-required')
      const original = await operationHistory(root, first.operationKey)
      assert.equal(original.operation.payload.amount, 4)
      assert.equal(original.run.payload.status, 'blocked')
      assert.partialDeepStrictEqual(original.attempt.payload, { phase: 'reconciliation-required', result: null })
      assert.equal(original.execution.payload.status, 'execution_unknown')
      const gateway = await createActionGateway(proofConfig(scope, 'executed'))
      const outcome = 'confirmed-no-effect'
      const qualified = makeQualification(unresolved, history.generation, outcome)
      const reconciling = await pauseWithAssessment(scope, unresolved, history.generation,
        { outcome, pauseClock: liveWriter ? 2 : undefined })
      assert.notEqual(reconciling.pid, process.pid)
      assert.deepEqual(await allowance(gateway), [4, 0, 6])
      const writerLock = await writerPath(root)
      reconciling.send({ type: 'release', epoch: 1 })

      let writer
      if (liveWriter) {
        await reconciling.next('writer-held')
        writer = await lstat(writerLock)
        assert.equal(writer.isFile(), true)
        assert.equal(writer.mode & 0o777, 0o600)
        await assertDecision(root, { revision: 1, qualification: qualified, eventCount: 1 })
        await assert.rejects(gateway.inspect(first.operationKey), { code: 'locked' })
      } else {
        assert.partialDeepStrictEqual(await reconciling.result(), {
          receipt: { status: 'applied', ...proofRequest, outcome: 'reconciled-no-effect' },
        })
        await assert.rejects(lstat(writerLock), { code: 'ENOENT' })
        await assertDecision(root, { revision: 2, qualification: qualified, eventCount: 1 })
        assert.deepEqual(await allowance(gateway), [0, 0, 10])
      }

      const beforeContinuation = await persistedFiles(root)
      continuation.resolve({ status: 'confirmed-success', evidenceRef: { id: 'late-effect', revision: 1 } })
      assert.deepEqual(await execution, {
        status: 'execution_unknown', code: liveWriter ? 'storage-failure' : 'reconciliation-required',
        executionId: history.binding.executionId,
      })
      assert.equal(history.decisionReads(), liveWriter ? 0 : 2)
      assert.equal(history.invocations(), 1)
      assert.deepEqual(await persistedFiles(root), beforeContinuation)
      await assertEntries(scope, [first])

      if (liveWriter) {
        const retained = await lstat(writerLock)
        assert.equal(retained.ino, writer.ino)
        assert.equal(retained.dev, writer.dev)
        reconciling.releaseWriter()
        assert.partialDeepStrictEqual(await reconciling.result(), {
          receipt: { status: 'applied', ...proofRequest, outcome: 'reconciled-no-effect' },
        })
      }

      await assertDecision(root, { revision: 2, qualification: qualified, eventCount: 1 })
      assert.deepEqual(await operationHistory(root, first.operationKey), original)
      assert.deepEqual(await allowance(gateway), [0, 0, 10])
      const applied = await persistedFiles(root)
      const restarted = await scope.start({ failResolver: true, failClock: true })
      restarted.send({ type: 'start' })
      assert.partialDeepStrictEqual(await restarted.result(), {
        receipt: { status: 'replayed', ...proofRequest, outcome: 'reconciled-no-effect' },
        resolverCalls: 0, clockCalls: 0,
      })
      assert.partialDeepStrictEqual(await gateway.execute(first), { reason: 'reconciled-no-effect', replayed: true })
      assert.deepEqual(await persistedFiles(root), applied)
      await assertEntries(scope, [first])
    } finally {
      continuation.resolve({ status: 'unknown' })
      try { await execution } finally { await scope.close() }
    }
  })
}
