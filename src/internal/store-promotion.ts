import { randomBytes } from 'node:crypto'
import { createTaskAllowance, nativeRunId } from './action-allowance.js'
import { computeSnapshotChecksum as digest, currentDigestVersion, legacyDigestVersion } from './digest.js'
import { readExecutionAudit } from './execution-audit.js'
import { loadAttempt, parseStoredProposal } from './execution-gateway.js'
import { executionStateIdentity, validateExecutionState } from './execution-state.js'
import { approvalDecisionId, parseApprovalDecision, parseApprovalRequest } from './gateway-approval.js'
import { policyInput } from './gateway-policy.js'
import {
  actionAllowanceKind, copyLocalJson, createExplicitStoreChecksum, encodeRecordEnvelope, localId, localObject, LocalStoreError, openExistingPromotionStore,
  taskManifestId, verifyRecordEnvelope, type LocalRecord, type LocalRecordPort, type LocalStoreOptions,
} from './local-store.js'
import { gatewayAgent, historicalDefinition, historicalProfile } from './reconciliation.js'
import { readReconciliationDecisions } from './reconciliation-decision.js'
import { isReconciliationRecordId } from './reconciliation-record.js'
import { projectManifest, taskStoreIdentity } from './store-manifest.js'
import { restoreRun, restoreTask } from './task-run-store.js'

type Snapshot = Awaited<ReturnType<Awaited<ReturnType<typeof openExistingPromotionStore>>['snapshot']>>

function requireHistory(condition: unknown): asserts condition {
  if (!condition) throw new Error('invalid-promotion-history')
}

async function verifyHistory(snapshot: Snapshot, taskId: string, projectId: string, checksumFor: LocalRecordPort['checksumFor']) {
  const collections = new Map<string, Map<string, LocalRecord>>()
  for (const [kind, entries] of snapshot.records) {
    collections.set(kind, new Map(entries.map(({ record }) => [record.id, record])))
    if (entries.some(({ record }) => record.digestVersion === legacyDigestVersion)) checksumFor(legacyDigestVersion)
  }

  const source = snapshot.records.get(actionAllowanceKind)?.find(({ record }) => record.id === taskManifestId)
  requireHistory(source)
  const { configuration, storeGeneration } = projectManifest(source.record, projectId, checksumFor)
  const snapshotPort = {
    checksumFor,
    async read(kind: string, id: string) { return collections.get(kind)?.get(id) ?? null },
    async list(kind: string) { return [...(collections.get(kind)?.values() ?? [])] },
  }

  const { task: taskSpec, action, revision, approverId } = configuration
  const taskRow = await snapshotPort.read('tasks', taskId)
  const task = taskRow && restoreTask(taskRow.payload)
  requireHistory((collections.get('tasks')?.size ?? 0) === (task ? 1 : 0)
    && (!task || (task.id === taskId && task.projectId === projectId)))
  const runs = new Map<string, ReturnType<typeof restoreRun>>()
  for (const row of collections.get('runs')!.values()) {
    requireHistory(task)
    const run = restoreRun(task, row.payload)
    requireHistory(run.id === row.id && run.revision === row.revision && run.maxSteps === taskSpec.cap
      && digest(run.agentDefinitionRef) === digest(gatewayAgent))
    runs.set(run.id, run)
  }

  const allowance = createTaskAllowance(projectId, taskId, taskSpec.cap, configuration)
  const accounted = new Set<LocalRecord>()
  const actionRef = { id: action, revision }
  const definition = historicalDefinition(actionRef)
  const profile = historicalProfile
  for (const row of collections.get(actionAllowanceKind)!.values()) {
    if (row.id === taskManifestId || isReconciliationRecordId(row.id)) continue
    const operation = allowance.parseOperation(row)
    const run = runs.get(nativeRunId(operation.runId))
    requireHistory(run && run.revision >= operation.runRevision && operation.createdAt >= run.createdAt)

    const proposalRow = await snapshotPort.read('proposals', row.id)
    // The first durable prefix contains only the recorded digests. The original
    // input is unavailable until the proposal is stored.
    if (!proposalRow) {
      requireHistory(operation.phase === 'pending')
      continue
    }
    const version = operation.digestVersion
    const hash = checksumFor(version)
    accounted.add(proposalRow)
    const { proposal, binding, taskRevision, requestId } = parseStoredProposal(proposalRow, version, hash)
    const input = localObject(proposal.input, ['payload', 'amount', 'unit', 'operationKey'])
    const scope = { id: `scope-${hash(configuration)}`, revision: 1, projectId, taskId,
      runId: run.id, agentRef: gatewayAgent, expiresAt: taskSpec.expiresAt }
    const executionBinding = { projectId, taskId, runId: run.id, proposalRef: { id: row.id, revision: 1 },
      proposalDigest: operation.proposalDigest }
    const identity = executionStateIdentity(executionBinding, hash)
    const exact = {
      ...executionBinding, taskRevision, baseRunRevision: operation.runRevision, agentRef: gatewayAgent, actionRef,
      definitionDigest: hash(copyLocalJson(definition)), policyProfileRef: { id: profile.id, revision: profile.revision },
      policyInputDigest: hash(policyInput(proposal, profile, false)),
      adapterRef: { id: 'action-gateway-local-handler', revision }, scopeDigest: hash({ scope, approvers: [approverId] }),
      executionId: identity.id, executionIdentity: identity.executionIdentity,
    }
    requireHistory(taskRevision === taskRow?.revision
      && proposal.schemaVersion === 'action-proposal/v0.1' && proposal.projectId === projectId && proposal.taskId === taskId
      && proposal.runId === run.id && proposal.revision === 1 && proposal.runRevision === operation.runRevision
      && proposal.createdAt === operation.createdAt && digest(proposal.actionRef) === digest(actionRef)
      && digest(proposal.agentRef) === digest(gatewayAgent)
      && digest(proposal.target) === digest({ kind: definition.targetKind, resource: operation.key })
      && input.operationKey === operation.key && input.amount === operation.amount && input.unit === taskSpec.unit
      && hash(input.payload) === operation.inputDigest && hash(proposal) === operation.proposalDigest
      && digest(exact) === digest(binding) && (!operation.binding || digest(operation.binding) === digest(binding)))

    const requestRow = await snapshotPort.read('approval-requests', requestId)
    if (requestRow) {
      accounted.add(requestRow)
      requireHistory(requestRow.revision === 1 && requestRow.digestVersion === version)
      const request = parseApprovalRequest(requestRow.payload, binding, proposal, hash)
      requireHistory(request.createdAt >= proposal.createdAt && request.expiresAt <= taskSpec.expiresAt)
      const decisionRow = await snapshotPort.read('approval-decisions', approvalDecisionId(request.id))
      if (decisionRow) {
        accounted.add(decisionRow)
        requireHistory(decisionRow.revision === 1 && decisionRow.digestVersion === version)
        const decision = parseApprovalDecision(decisionRow.payload, request, hash)
        requireHistory(decision.approverId === approverId && (operation.phase === 'pending' || decision.decision === 'APPROVED'))
      } else requireHistory(operation.phase === 'pending')
    } else requireHistory(operation.phase === 'pending')

    const attempt = await loadAttempt(snapshotPort, binding, version)
    const execution = await snapshotPort.read('execution', identity.id)
    if (execution) {
      accounted.add(execution)
      const value = validateExecutionState(execution.payload, hash)
      // The proposal timestamp has already been checked against Run creation.
      requireHistory(operation.phase === 'held'
        && execution.digestVersion === version && execution.revision === value.revision && value.id === execution.id
        && value.executionIdentity === identity.executionIdentity && value.createdAt >= proposal.createdAt
        && (!attempt || value.createdAt <= attempt.value.createdAt))
    }
    if (attempt) {
      accounted.add(attempt.record)
      requireHistory(operation.phase === 'held')
    }
  }
  for (const kind of ['proposals', 'approval-requests', 'approval-decisions', 'execution', 'gateway-attempts']) {
    for (const row of collections.get(kind)!.values()) requireHistory(accounted.has(row))
  }
  const decisions = await readReconciliationDecisions(snapshotPort, { read: async () => snapshot.audit }, projectId)
  await allowance.snapshot(snapshotPort, undefined, decisions)
  for (const { event } of readExecutionAudit(snapshot.audit, projectId)) {
    requireHistory(event.taskId === taskId)
  }
  return { source, storeGeneration }
}

/** Offline and format-only. Checkpoints are private fault-injection hooks. */
export async function promoteTaskStore(directory: string, originalTaskId: string, locale?: string, options: LocalStoreOptions = {}) {
  if (!localId(originalTaskId)) throw new LocalStoreError('invalid-id')
  const checksumFor = createExplicitStoreChecksum(locale)
  const { projectId, taskId } = taskStoreIdentity(originalTaskId)
  const store = await openExistingPromotionStore(directory, projectId, checksumFor, options)
  await store.requireStateUnlocked()
  await store.requireAuditUnlocked()
  const preflight = await store.snapshot()
  await verifyHistory(preflight, taskId, projectId, checksumFor)
  await store.requireAuditUnlocked()

  return store.exclusive(async (manifest) => {
    await store.requireAuditUnlocked()
    const authoritative = await store.snapshot()
    if (authoritative.fingerprint !== preflight.fingerprint) throw new LocalStoreError('stale-revision')
    const { source, storeGeneration } = await verifyHistory(authoritative, taskId, projectId, checksumFor)
    await store.requireAuditUnlocked()
    let expected = source.envelope
    if (storeGeneration === null) {
      const generation = randomBytes(32).toString('hex')
      expected = encodeRecordEnvelope({
        kind: actionAllowanceKind, id: taskManifestId, projectId, revision: 2,
        payload: { schemaVersion: 'action-allowance/v0.2', storeGeneration: generation, sourceManifest: source.envelope },
      })
      const candidate = verifyRecordEnvelope(expected, projectId, actionAllowanceKind, checksumFor, taskManifestId)
      projectManifest(candidate.record, projectId, checksumFor)
      await manifest.replace(expected)
    } else {
      // Establish directory durability even if an earlier process lost its acknowledgement.
      await manifest.sync()
    }
    const installed = await manifest.read()
    const result = projectManifest(installed.record, projectId, checksumFor)
    if (installed.envelope.checksum !== expected.checksum || result.storeGeneration === null) {
      throw new LocalStoreError('write-uncertain')
    }
    return result.storeGeneration
  })
}
