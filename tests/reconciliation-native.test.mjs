import assert from 'node:assert/strict'
import test from 'node:test'
import { createActionGateway } from '../dist/index.js'
import { createTaskAllowance, operationId } from '../dist/internal/action-allowance.js'
import { computeSnapshotChecksum as digest, currentDigestVersion } from '../dist/internal/digest.js'
import { createExecutionAuditStore } from '../dist/internal/execution-audit.js'
import { createTrustedExecutionGateway } from '../dist/internal/execution-gateway.js'
import { createExecutionStateStore } from '../dist/internal/execution-state.js'
import { actionAllowanceKind, taskManifestId } from '../dist/internal/local-store.js'
import { gatewayAgent, historicalDefinition, historicalProfile } from '../dist/internal/reconciliation.js'
import { projectManifest } from '../dist/internal/store-manifest.js'
import { promoteTaskStore } from '../dist/internal/store-promotion.js'
import { createTaskRunStore } from '../dist/internal/task-run-store.js'
import { transitionRun } from '../dist/internal/task-run.js'
import { config, first, persistedFiles, time, workspace } from './fixture.mjs'
import { decisionRows, makeQualification, openHistory, openKernel, readSubject } from './reconciliation-decision-fixture.mjs'

async function startNative(root, entered, continuation) {
  const options = config(root)
  const gateway = await createActionGateway({ ...options, review: async () => 'PENDING' })
  const pending = await gateway.execute(first)
  assert.equal(pending.decision, 'APPROVAL_REQUIRED')
  const generation = await promoteTaskStore(root, options.task.id)
  const { state, audit, projectId } = await openHistory(root)
  const manifest = await state.read(actionAllowanceKind, taskManifestId)
  const { configuration } = projectManifest(manifest, projectId, state.checksumFor)
  const proposalRow = await state.read('proposals', operationId(first.operationKey))
  const { binding } = proposalRow.payload
  const { taskId, runId } = binding
  const allowance = createTaskAllowance(projectId, taskId, options.task.cap, configuration)
  let decisionReads = 0
  let invocations = 0
  const observedState = {
    ...state,
    exclusive: (work) => state.exclusive((port) => work({
      ...port,
      read(kind, id) {
        if (kind === actionAllowanceKind && id.startsWith('reconciliation-')) decisionReads++
        return port.read(kind, id)
      },
    })),
  }
  const native = createTrustedExecutionGateway({
    digestVersion: currentDigestVersion,
    scope: { id: 'scope-' + digest(configuration), revision: 1, projectId, taskId, runId,
      agentRef: gatewayAgent, expiresAt: options.task.expiresAt },
    state: observedState,
    audit,
    agent: { id: gatewayAgent.id, declarativeProfile: { schemaVersion: 'agent-profile/v0.1', revision: 1,
      executionAvailable: false, capabilityIds: ['local-action'], actionIds: [options.tool.id] } },
    approverIds: [options.approverId],
    approvalLifetimeMs: 300_000,
    adapterTimeoutMs: 30_000,
    host: {
      actorId: gatewayAgent.id, now: () => time, scopeIsCurrent: () => true, actionIsInScope: () => true,
      captureDecision: async () => ({ approverId: options.approverId, decision: 'APPROVED' }),
    },
    admit: (port, exact) => allowance.reserve(port, first.operationKey, exact, currentDigestVersion),
    actions: [{ definition: historicalDefinition(binding.actionRef), profile: historicalProfile,
      adapter: { id: binding.adapterRef.id, revision: binding.adapterRef.revision, invoke(context) {
        assert.equal(context.isAuthorized(context.authority, context.executionIdentity, context.proposalDigest), true)
        invocations++
        entered.resolve()
        return continuation.promise
      } } }],
  })
  await native.captureApproval(pending.approvalRequestId)
  return { native, state, audit, binding, generation, gateway, proposalId: proposalRow.id,
    decisionReads: () => decisionReads, invocations: () => invocations }
}

async function installInterruptedPrefix({ state, audit, binding }) {
  // Inject the same durable observations as a completed UNKNOWN path while leaving
  // the original adapter continuation stalled. This exercises a late historical writer.
  const { projectId, taskId, runId, executionId, proposalRef } = binding
  await state.exclusive(async (port) => {
    const executions = createExecutionStateStore(port, projectId, currentDigestVersion)
    await executions.recordObservation(executionId, 2, 'execution_unknown', time)
    const workflow = createTaskRunStore(port, projectId)
    const { task } = await workflow.loadTask(taskId)
    const run = await workflow.loadRun(runId)
    const blocked = transitionRun(task, run, { id: 'block-' + digest(binding), type: 'block', projectId, taskId,
      runId, expectedRevision: run.revision, occurredAt: time, actionRef: proposalRef })
    assert.equal(blocked.status, 'applied')
    await workflow.saveRun(blocked.run, run.revision)
    const attempt = await port.read('gateway-attempts', executionId)
    assert.equal(attempt.revision, 2)
    assert.equal(attempt.payload.phase, 'reserved')
    await port.save({ ...attempt, revision: 3, payload: { ...attempt.payload, phase: 'reconciliation-required' } }, 2)
    const type = 'execution-result-recorded'
    const observationCode = 'execution-unknown'
    await createExecutionAuditStore(audit, projectId).append({
      schemaVersion: 'execution-audit-event/v0.1',
      id: 'event-' + digest([proposalRef.id, proposalRef.revision, type, observationCode]),
      projectId, taskId, runId, occurredAt: time, type, actorId: gatewayAgent.id, observationCode,
      subjectRef: { kind: 'proposal', ...proposalRef },
    })
  })
}

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
