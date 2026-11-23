import { createTaskAllowance, operationId, positiveInteger } from './action-allowance.js'
import type { ActionDefinition, ActionTarget } from './action-contract.js'
import { computeSnapshotChecksum as digest, currentDigestVersion, legacyDigestVersion, type DigestVersion } from './digest.js'
import { readExecutionAudit, type ExecutionAuditEvent, type ExecutionAuditPort } from './execution-audit.js'
import { loadAttempt, parseStoredProposal } from './execution-gateway.js'
import { validateExecutionState } from './execution-state.js'
import { approvalDecisionId, parseApprovalDecision, parseApprovalRequest } from './gateway-approval.js'
import type { ActionPolicyProfile, ExactActionBinding } from './gateway-contract.js'
import { policyInput } from './gateway-policy.js'
import { actionAllowanceKind, copyLocalJson, localId, localObject, localRevision, localTimestamp, type LocalRecordPort } from './local-store.js'
import { restoreRun, restoreTask } from './task-run-store.js'

type ReadState = Pick<LocalRecordPort, 'read' | 'checksumFor'>

export type ReconciliationSubject = Readonly<{
  projectId: string
  taskId: string
  originalTaskId: string
  originalRunId: string
  operationKey: string
  digestVersion: DigestVersion
  inputDigest: string
  proposalDigest: string
  binding: ExactActionBinding
  approvalRequestId: string
  approvalRequestDigest: string
  approvalDecisionId: string
  target: ActionTarget
  amount: number
  unit: string
  attemptId: string
  revisions: Readonly<{ manifest: number; operation: number; proposal: number; request: number; decision: number }>
}>

type Refusal = 'missing-operation' | 'not-held' | 'missing-attempt' | 'closed-attempt' | 'unsupported-prefix' | 'invalid-history'
type SubjectResult =
  | Readonly<{ status: 'ineligible'; reason: Refusal }>
  | Readonly<{
    status: 'eligible'; observedPrefix: 'reserved' | 'reconciliation-required'
    subject: ReconciliationSubject; subjectDigest: string; expectedState: string
  }>

const gatewayActor = 'action-gateway-host'
const gatewayAgent = { id: gatewayActor, revision: 1 }

// Pin the v0.1.1 host definition and profile for historical verification.
function historicalDefinition(actionRef: ExactActionBinding['actionRef']): ActionDefinition {
  return {
    ...actionRef, category: 'local-action', description: 'Trusted host registered action', requiredCapability: 'local-action',
    targetKind: 'logical-operation', targetInputField: 'operationKey', riskLevel: 'medium', sideEffect: 'execute',
    auditRequired: true, approvalMayBeRequired: true, executionAvailable: false,
    inputFields: { payload: { type: 'object', required: true }, amount: { type: 'number', required: true },
      unit: { type: 'string', required: true }, operationKey: { type: 'string', required: true } },
  }
}

const historicalProfile: ActionPolicyProfile = {
  id: 'action-gateway-local', revision: 1, permissionTier: 2,
  flags: { involvesSecrets: false, involvesProduction: false, involvesExternalIntegration: false, involvesRealUserData: false,
    involvesFinancialOrLegalOrHealthData: false, proposesCommitOrPush: false, proposesDeployment: false, proposesPublicClaim: false },
}

function requireHistory(condition: unknown): asserts condition {
  if (!condition) throw new Error('invalid-reconciliation-history')
}

function refuse(reason: Refusal): SubjectResult {
  return Object.freeze({ status: 'ineligible', reason })
}

function same(left: unknown, right: unknown): boolean {
  return digest(left) === digest(right)
}

type AuditObservation = Readonly<{
  type: ExecutionAuditEvent['type']; code: string; occurredAt?: string; actorId?: string
}>

function authorizationAnchors(
  history: string, binding: ExactActionBinding, observations: readonly AuditObservation[],
  attemptCreatedAt: string, approvalExpiresAt: string, lastUpdatedAt: string,
) {
  const { projectId, taskId, runId, proposalRef } = binding
  const relevant = readExecutionAudit(history, projectId).filter(({ event }) =>
    event.subjectRef.kind === 'proposal' && event.subjectRef.id === proposalRef.id)
  if (relevant.length !== observations.length) return null

  for (const [index, expected] of observations.entries()) {
    const { event } = relevant[index]
    const expectedId = `event-${digest([proposalRef.id, proposalRef.revision, expected.type, expected.code])}`
    if (event.id !== expectedId || event.taskId !== taskId || event.runId !== runId
      || event.subjectRef.revision !== proposalRef.revision || event.type !== expected.type
      || event.observationCode !== expected.code || event.actorId !== (expected.actorId ?? gatewayActor)
      || (expected.occurredAt !== undefined && event.occurredAt !== expected.occurredAt)) return null
    if (event.type === 'execution-authority-granted'
      && (event.occurredAt < attemptCreatedAt || event.occurredAt >= approvalExpiresAt)) return null
    if (event.type === 'execution-result-recorded'
      && (event.occurredAt < lastUpdatedAt || event.occurredAt < relevant[index - 1].event.occurredAt)) return null
  }
  // Chain verification comes first. Only the selected event contents enter the token.
  return relevant.map(({ eventHash }) => eventHash)
}

/**
 * Read a v0.1.1 history through existing ports. Eligibility is structural even
 * if the original worker is still live. The token must be rechecked under the
 * writer by any future decision path.
 */
export async function readReconciliationSubject(
  state: ReadState, audit: Pick<ExecutionAuditPort, 'read'>, projectId: string, operationKey: string,
): Promise<SubjectResult> {
  try {
    requireHistory(localId(operationKey) && localId(projectId))
    const read = async (kind: string, id: string) => {
      const record = await state.read(kind, id)
      requireHistory(!record || (record.kind === kind && record.id === id && record.projectId === projectId))
      return record
    }

    const operationRow = await read(actionAllowanceKind, operationId(operationKey))
    if (!operationRow) return refuse('missing-operation')
    const manifestRow = await read(actionAllowanceKind, 'task-allowance')
    requireHistory(manifestRow?.revision === 1)
    const manifest = localObject(manifestRow.payload, ['schemaVersion', 'task', 'action', 'revision', 'approverId', 'timeoutMs'])
    const taskSpec = localObject(manifest.task, ['id', 'cap', 'unit', 'expiresAt'])
    requireHistory(manifest.schemaVersion === 'action-allowance/v0.1' && localId(taskSpec.id)
      && positiveInteger(taskSpec.cap) && localId(taskSpec.unit) && localTimestamp(taskSpec.expiresAt)
      && localId(manifest.action) && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(manifest.action)
      && localRevision(manifest.revision) && localId(manifest.approverId)
      && positiveInteger(manifest.timeoutMs) && manifest.timeoutMs <= 30_000)
    const taskHash = digest(taskSpec.id)
    const taskId = `task-action-${taskHash}`
    requireHistory(projectId === `project-action-${taskHash}`)
    const allowance = createTaskAllowance(projectId, taskId, taskSpec.cap, manifest)
    const operation = allowance.parseOperation(operationRow)
    requireHistory(operation.key === operationKey)
    if (operation.phase !== 'held') return refuse('not-held')

    const { binding, digestVersion, amount } = operation
    requireHistory(binding && amount <= taskSpec.cap
      && (digestVersion === currentDigestVersion || digestVersion === legacyDigestVersion))
    const hash = state.checksumFor(digestVersion)
    const attempt = await loadAttempt({ read, checksumFor: (version) => state.checksumFor(version) }, binding, digestVersion)
    if (!attempt) return refuse('missing-attempt')
    if (attempt.value.phase === 'closed') return refuse('closed-attempt')
    const interrupted = attempt.value.phase === 'reconciliation-required'
    if (attempt.value.result !== null || attempt.value.pendingEvents.length !== 0
      || attempt.record.revision !== (interrupted ? 3 : 2)) return refuse('unsupported-prefix')

    const proposalRow = await read('proposals', operationRow.id)
    requireHistory(proposalRow)
    // Use the same safe copy as the durable reader before any legacy hash of the proposal or its payload.
    const safeProposalRow = digestVersion === legacyDigestVersion
      ? { ...proposalRow, payload: copyLocalJson(proposalRow.payload) }
      : proposalRow
    const { proposal, taskRevision, binding: originalBinding, requestId } = parseStoredProposal(safeProposalRow, digestVersion, hash)
    const actionRef = { id: manifest.action, revision: manifest.revision }
    const definition = historicalDefinition(actionRef)
    const { riskLevel, sideEffect, auditRequired, approvalMayBeRequired } = definition
    const target = { kind: definition.targetKind, resource: operationKey }
    const scope = { id: `scope-${hash(manifestRow.payload)}`, revision: 1, projectId, taskId,
      runId: binding.runId, agentRef: gatewayAgent, expiresAt: taskSpec.expiresAt }
    localObject(proposal, ['schemaVersion', 'id', 'revision', 'projectId', 'taskId', 'runId', 'runRevision',
      'agentRef', 'actionRef', 'input', 'target', 'createdAt', 'category', 'riskContext', 'executionAvailable'])
    const input = localObject(proposal.input, ['payload', 'amount', 'unit', 'operationKey'])
    requireHistory(input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
      && input.operationKey === operationKey && input.amount === amount && input.unit === taskSpec.unit
      && hash(input.payload) === operation.inputDigest && hash(proposal) === operation.proposalDigest
      && proposal.schemaVersion === 'action-proposal/v0.1' && proposal.revision === 1
      && proposal.projectId === projectId && proposal.taskId === taskId && proposal.runId === binding.runId
      && proposal.runRevision === operation.runRevision && proposal.createdAt === operation.createdAt
      && proposal.category === definition.category && proposal.executionAvailable === definition.executionAvailable
      && same(proposal.riskContext, { riskLevel, sideEffect, auditRequired, approvalMayBeRequired })
      && same(proposal.target, target) && same(proposal.actionRef, actionRef) && same(binding.actionRef, actionRef)
      && same(proposal.agentRef, gatewayAgent) && same(binding.agentRef, gatewayAgent)
      && same(binding.proposalRef, { id: proposal.id, revision: proposal.revision })
      && same(binding.policyProfileRef, { id: historicalProfile.id, revision: historicalProfile.revision })
      && same(binding.adapterRef, { id: 'action-gateway-local-handler', revision: manifest.revision })
      && binding.definitionDigest === hash(copyLocalJson(definition))
      && binding.policyInputDigest === hash(policyInput(proposal, historicalProfile, false))
      && same(binding, originalBinding) && taskRevision === binding.taskRevision
      && binding.scopeDigest === hash({ scope, approvers: [manifest.approverId] }))

    const requestRow = await read('approval-requests', requestId)
    requireHistory(requestRow?.revision === 1 && requestRow.digestVersion === digestVersion)
    const request = parseApprovalRequest(requestRow.payload, binding, proposal, hash)
    const decisionRow = await read('approval-decisions', approvalDecisionId(request.id))
    requireHistory(decisionRow?.revision === 1 && decisionRow.digestVersion === digestVersion)
    const decision = parseApprovalDecision(decisionRow.payload, request, hash)
    requireHistory(decision.decision === 'APPROVED' && decision.approverId === manifest.approverId
      && request.createdAt >= proposal.createdAt && request.expiresAt <= taskSpec.expiresAt
      && decision.decidedAt <= attempt.value.createdAt)

    const taskRow = await read('tasks', taskId)
    const runRow = await read('runs', binding.runId)
    const executionRow = await read('execution', binding.executionId)
    requireHistory(taskRow?.revision === taskRevision && runRow && executionRow?.digestVersion === digestVersion)
    const task = restoreTask(taskRow.payload)
    const run = restoreRun(task, runRow.payload)
    const execution = validateExecutionState(executionRow.payload, hash)
    requireHistory(task.id === taskId && task.projectId === projectId && run.id === binding.runId
      && run.revision === runRow.revision && run.maxSteps === taskSpec.cap && same(run.agentDefinitionRef, gatewayAgent)
      && execution.id === binding.executionId && execution.executionIdentity === binding.executionIdentity
      && execution.projectId === projectId && execution.taskId === taskId && execution.runId === run.id
      && same(execution.proposalRef, binding.proposalRef) && execution.proposalDigest === operation.proposalDigest
      && execution.revision === executionRow.revision && execution.createdAt >= run.createdAt && proposal.createdAt >= run.createdAt
      && execution.createdAt <= attempt.value.createdAt)

    const tail = run.appliedEvents.slice(operation.runRevision - 1)
    const [awaited, resolved, blocked] = tail
    if (tail.length !== (interrupted ? 3 : 2) || run.status !== (interrupted ? 'blocked' : 'running')
      || awaited?.type !== 'await-approval' || resolved?.type !== 'resolve-approval' || resolved.outcome !== 'approved'
      || !same(awaited.actionRef, binding.proposalRef) || !same(resolved.actionRef, binding.proposalRef)
      || !same(resolved.approvalRef, { id: decision.id, revision: decisionRow.revision })
      || awaited.occurredAt < request.createdAt || resolved.occurredAt < decision.decidedAt
      || resolved.occurredAt > attempt.value.createdAt
      || execution.status !== (interrupted ? 'execution_unknown' : 'execution_started')) return refuse('unsupported-prefix')
    if (interrupted ? blocked?.type !== 'block' || !same(blocked.actionRef, binding.proposalRef)
      || execution.updatedAt < attempt.value.createdAt || blocked.occurredAt < execution.updatedAt
      : execution.updatedAt !== attempt.value.createdAt) return refuse('unsupported-prefix')

    const observations: AuditObservation[] = [
      { type: 'approval-requested', code: 'exact-action-requested', occurredAt: request.createdAt },
      { type: 'approval-recorded', code: 'exact-action-approved', occurredAt: decision.decidedAt, actorId: decision.approverId },
      { type: 'action-proposed', code: 'registered-proposal', occurredAt: proposal.createdAt },
      { type: 'policy-evaluated', code: 'exact-approval-policy-allow', occurredAt: attempt.value.createdAt },
      { type: 'execution-started', code: 'reserved-before-adapter', occurredAt: attempt.value.createdAt },
      { type: 'execution-authority-granted', code: 'ephemeral-permit-created' },
    ]
    if (interrupted) observations.push({ type: 'execution-result-recorded', code: 'execution-unknown' })
    const auditAnchors = authorizationAnchors(await audit.read(), binding, observations,
      attempt.value.createdAt, request.expiresAt, run.updatedAt)
    if (!auditAnchors) return refuse('unsupported-prefix')

    const subject = copyLocalJson({
      projectId, taskId, originalTaskId: taskSpec.id, originalRunId: operation.runId, operationKey, digestVersion,
      inputDigest: operation.inputDigest, proposalDigest: operation.proposalDigest, binding,
      approvalRequestId: request.id, approvalRequestDigest: decision.requestDigest, approvalDecisionId: decision.id,
      target, amount, unit: taskSpec.unit, attemptId: attempt.record.id,
      revisions: { manifest: manifestRow.revision, operation: operationRow.revision, proposal: proposalRow.revision,
        request: requestRow.revision, decision: decisionRow.revision },
    } satisfies ReconciliationSubject) as ReconciliationSubject
    const subjectDigest = digest({ domain: 'action-gateway/reconciliation-subject/v1', subject })
    const expectedState = digest({
      domain: 'action-gateway/reconciliation-state/v1', subjectDigest,
      operation: digest(operationRow.payload), attempt: digest(attempt.record), execution: digest(execution),
      run: { revision: run.revision, events: tail },
      approval: digest(decision), auditAnchors,
    })
    return Object.freeze({ status: 'eligible', observedPrefix: attempt.value.phase, subject, subjectDigest, expectedState })
  } catch {
    return refuse('invalid-history')
  }
}
