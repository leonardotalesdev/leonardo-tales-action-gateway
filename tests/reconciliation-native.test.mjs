import assert from 'node:assert/strict'
import test from 'node:test'
import { first, persistedFiles, time, workspace } from './fixture.mjs'
import { decisionRows, installInterruptedPrefix, makeQualification, openKernel, readSubject, startNative } from './reconciliation-decision-fixture.mjs'

for (const late of ['known result', 'unknown result', 'adapter exception']) {
  test('a qualified R3 decision fences native interruption and late ' + late, async (t) => {
    const root = await workspace(t)
    const entered = Promise.withResolvers()
    const continuation = Promise.withResolvers()
    const history = await startNative(root, entered, continuation)
    const { native, proposalId } = history
    const execution = native.execute(proposalId)
    try {
      await Promise.race([entered.promise, execution.then((result) => assert.fail(JSON.stringify(result)))])
      assert.equal((await readSubject(root)).observedPrefix, 'reserved')
      await installInterruptedPrefix(history)
      const subject = await readSubject(root)
      assert.equal(subject.observedPrefix, 'reconciliation-required')

      let samples = 0
      const kernel = await openKernel(root, { now() {
        if (samples++ === 0) return time
        throw new Error('fault after durable qualification audit')
      } })
      const q = makeQualification(subject, history.generation)
      await assert.rejects(kernel.adjudicator.apply(kernel.issuer.issue(q)), { code: 'invalid-clock' })
      assert.equal((await decisionRows(root))[0].envelope.record.payload.phase, 'qualified')
      assert.equal((await history.gateway.inspect(first.operationKey)).decision, 'UNKNOWN')
      const before = await persistedFiles(root)

      await assert.rejects(native.recordInterrupted(proposalId), { code: 'reconciliation-required' })
      assert.equal(history.decisionReads(), 1)
      if (late === 'adapter exception') continuation.reject(new Error('late adapter rejection'))
      else continuation.resolve(late === 'known result'
        ? { status: 'confirmed-success', evidenceRef: { id: 'late-effect', revision: 1 } }
        : { status: 'unknown' })
      assert.deepEqual(await execution, {
        status: 'execution_unknown', code: 'reconciliation-required', executionId: history.binding.executionId,
      })
      assert.equal(history.decisionReads(), 3, 'finalizer and its exception fallback both check R3 under the state writer')
      assert.equal(history.invocations(), 1)
      assert.deepEqual(await persistedFiles(root), before)
      assert.deepEqual(await readSubject(root), subject)

      const reopened = await openKernel(root)
      assert.equal((await reopened.adjudicator.apply(reopened.issuer.issue(q))).revision, 2)
      assert.equal((await history.gateway.inspect(first.operationKey)).reason, 'reconciled-effect')
      assert.equal(history.invocations(), 1)
    } finally {
      continuation.resolve({ status: 'unknown' })
      await execution
    }
  })
}
