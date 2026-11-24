import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createActionGateway } from '../dist/index.js'
import { createTaskAllowance, operationId } from '../dist/internal/action-allowance.js'
import { computeSnapshotChecksum as digest, currentDigestVersion } from '../dist/internal/digest.js'
import { createExecutionAuditStore } from '../dist/internal/execution-audit.js'
import { createTrustedExecutionGateway } from '../dist/internal/execution-gateway.js'
import { createExecutionStateStore } from '../dist/internal/execution-state.js'
import { actionAllowanceKind, openLocalAuditPort, openLocalRecordStore, openReconciliationStore, taskManifestId } from '../dist/internal/local-store.js'
import { createReconciliationDecisionKernel } from '../dist/internal/reconciliation-decision.js'
import { gatewayAgent, historicalDefinition, historicalProfile, readReconciliationSubject } from '../dist/internal/reconciliation.js'
import { projectManifest, taskStoreIdentity } from '../dist/internal/store-manifest.js'
import { promoteTaskStore } from '../dist/internal/store-promotion.js'
import { createTaskRunStore } from '../dist/internal/task-run-store.js'
import { transitionRun } from '../dist/internal/task-run.js'
import { config, first, projectDirectory, records, time, workspace } from './fixture.mjs'

export async function openHistory(root, legacyDigestLocale) {
  const { projectId } = taskStoreIdentity(config(root).task.id)
  const state = await openLocalRecordStore(join(root, 'state'), projectId, { legacyDigestLocale })
  const audit = await openLocalAuditPort(join(root, 'audit'), projectId)
  return { state, audit, projectId }
}

export async function readSubject(root, operationKey = first.operationKey, legacyDigestLocale) {
  const { state, audit, projectId } = await openHistory(root, legacyDigestLocale)
  return readReconciliationSubject(state, audit, projectId, operationKey)
}

export async function openKernel(root, { now = () => time, ...storeOptions } = {}) {
  const { projectId } = taskStoreIdentity(config(root).task.id)
  const store = await openReconciliationStore(root, projectId, storeOptions)
  return createReconciliationDecisionKernel({ store, now })
}

export function makeQualification(subject, storeGeneration, outcome = 'confirmed-effect', overrides = {}) {
  assert.equal(subject.status, 'eligible')
  const { projectId, taskId, operationKey, attemptId, binding } = subject.subject
  return {
    requestId: 'recovery-request-' + operationKey,
    actorId: 'trusted-resolver',
    projectId, taskId, operationKey, attemptId, executionIdentity: binding.executionIdentity,
    storeGeneration, subjectDigest: subject.subjectDigest, expectedState: subject.expectedState,
    outcome,
    evidenceRef: { id: 'qualified-evidence-' + operationKey, revision: 1 },
    evidenceDigest: digest('dossier-' + operationKey),
    proof: outcome === 'confirmed-effect'
      ? { effectOccurredDigest: digest('effect-' + operationKey) }
      : { effectAbsentDigest: digest('absent-' + operationKey), attemptFinalityDigest: digest('final-' + operationKey) },
    qualifiedAt: time,
    ...overrides,
  }
}

export async function decisionRows(root) {
  return (await records(root, 'action-allowance')).filter(({ envelope }) => envelope.record.id.startsWith('reconciliation-'))
}

export async function auditPath(root) {
  return join(await projectDirectory(root, 'audit'), 'events.jsonl')
}

export async function journal(root) {
  return (await readFile(await auditPath(root), 'utf8')).trimEnd().split('\n').filter(Boolean).map(JSON.parse)
}

export async function promotedAmbiguous(t, outcome = 'confirmed-effect') {
  const root = await workspace(t)
  const options = config(root)
  const calls = { measure: 0, review: 0, handler: 0 }
  options.tool.amount = (input) => { calls.measure++; return input.rows }
  options.review = async () => { calls.review++; return 'APPROVED' }
  options.tool.execute = async () => { calls.handler++; return { outcome: 'unknown' } }
  const gateway = await createActionGateway(options)
  const receipt = await gateway.execute(first)
  assert.equal(receipt.decision, 'UNKNOWN')
  const generation = await promoteTaskStore(root, options.task.id)
  const subject = await readSubject(root)
  assert.equal(subject.observedPrefix, 'reconciliation-required')
  const qualification = makeQualification(subject, generation, outcome)
  return { root, directory: root, options, calls, gateway, receipt, generation, subject, qualification }
}

export async function startNative(root, entered, continuation) {
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

export async function installInterruptedPrefix({ state, audit, binding }) {
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
