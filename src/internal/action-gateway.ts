import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { createTaskRunStore } from './task-run-store.js'
import { createTask, createRun, getRunNextAction, transitionRun, type Run, type Task } from './task-run.js'
import { validateActionProposal, type ActionDefinition, type ActionInput } from './action-contract.js'
import { createTaskAllowance, nativeRunId, operationId, positiveInteger, type Operation, type RefusalBalance } from './action-allowance.js'
import { createTrustedExecutionGateway, parseStoredProposal } from './execution-gateway.js'
import { approvalDecisionId, parseApprovalDecision, parseApprovalRequest } from './gateway-approval.js'
import { ExecutionGatewayError, type ExactApprovalRequest, type GatewayAction } from './gateway-contract.js'
import { computeSnapshotChecksum as digest, currentDigestVersion } from './digest.js'
import { actionAllowanceKind, copyLocalJson, localId, localObject, localTimestamp, openLocalAuditPort, openLocalRecordStore, canonicalGatewayPath, type LocalLockedRecordPort, type LocalRecord, type LocalRecordPort } from './local-store.js'

import { taskStoreIdentity, type TaskSettings } from './store-manifest.js'
import { hasReconciliationData, readReconciliationDecisions } from './reconciliation-decision.js'
import type { ReconciliationRecord } from './reconciliation-record.js'
type Decision = 'APPROVED' | 'DENIED' | 'PENDING'
export type ActionReview = Readonly<{
  taskId: string; runId: string; operationKey: string; action: string; input: ActionInput
  amount: number; unit: string; cap: number; requestId: string; requestDigest: string; expiresAt: string
}>
export type ActionOutcome = Readonly<{ outcome: 'executed' | 'no-effect'; evidenceId: string } | { outcome: 'unknown' }>
export type ActionReceipt = Readonly<{
  taskId: string; runId: string; operationKey: string; action: string; inputDigest: string; proposalDigest: string
  unit: string; requested: number; cap: number; settled: number; held: number; remaining: number
  refusalBasis: Readonly<RefusalBalance & { requested: number }> | null
  decision: 'APPROVAL_REQUIRED' | 'EXECUTED' | 'BLOCKED' | 'UNKNOWN' | 'CONFLICT'
  reason: string; approvalRequestId: string | null; evidenceId: string | null; replayed: boolean
}>
export type ActionGatewayOptions = Readonly<{
  directory: string
  task: TaskSettings
  tool: Readonly<{
    id: string; revision: number
    amount(input: ActionInput): number
    execute(input: ActionInput, signal: AbortSignal): Promise<ActionOutcome>
  }>
  approverId: string
  review(request: ActionReview): Promise<Decision>
  /** Original Node/ICU collation for v0.1.0 records, if different from the current default. */
  legacyDigestLocale?: string
  now?(): string
  timeoutMs?: number
}>

function runAction<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}

/** Trusted local host only. Expose a narrower input-only tool wrapper to an agent. */
export async function createActionGateway(options: ActionGatewayOptions) {
  const { directory, approverId, review, timeoutMs = 10_000, now = () => new Date().toISOString() } = options
  const task = copyLocalJson(options.task) as TaskSettings
  const { id: action, revision, amount: measure, execute: handler } = options.tool
  if (!canonicalGatewayPath(directory)
    || !localId(task.id) || !localId(task.unit) || !positiveInteger(task.cap) || !localTimestamp(task.expiresAt)
    || !localId(approverId) || !localId(action) || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(action)
    || !positiveInteger(revision) || !positiveInteger(timeoutMs) || timeoutMs > 30_000
    || typeof measure !== 'function' || typeof handler !== 'function' || typeof review !== 'function') throw new Error('invalid-action-gateway-config')
  localObject(task, ['id', 'cap', 'unit', 'expiresAt'])
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('unsafe-action-gateway-directory')
  const { projectId, taskId } = taskStoreIdentity(task.id)
  const manifest = { schemaVersion: 'action-allowance/v0.1', task, action, revision, approverId, timeoutMs }
  const state = await openLocalRecordStore(join(directory, 'state'), projectId, { legacyDigestLocale: options.legacyDigestLocale })
  const audit = await openLocalAuditPort(join(directory, 'audit'), projectId)
  const allowance = createTaskAllowance(projectId, taskId, task.cap, manifest)
  const agentRef = { id: 'action-gateway-host', revision: 1 }
  const agent = {
    id: agentRef.id,
    declarativeProfile: {
      schemaVersion: 'agent-profile/v0.1' as const, revision: 1, executionAvailable: false as const,
      capabilityIds: ['local-action'], actionIds: [action],
    },
  }
  const definition: ActionDefinition = {
    id: action, revision, category: 'local-action', description: 'Trusted host registered action', requiredCapability: 'local-action',
    targetKind: 'logical-operation', targetInputField: 'operationKey', riskLevel: 'medium', sideEffect: 'execute',
    auditRequired: true, approvalMayBeRequired: true, executionAvailable: false,
    inputFields: { payload: { type: 'object', required: true }, amount: { type: 'number', required: true },
      unit: { type: 'string', required: true }, operationKey: { type: 'string', required: true } },
  }
  const profile: GatewayAction['profile'] = {
    id: 'action-gateway-local', revision: 1, permissionTier: 2,
    flags: { involvesSecrets: false, involvesProduction: false, involvesExternalIntegration: false, involvesRealUserData: false,
      involvesFinancialOrLegalOrHealthData: false, proposesCommitOrPush: false, proposesDeployment: false, proposesPublicClaim: false },
  }

  async function workflow(port: LocalRecordPort, runId: Run['id']) {
    const store = createTaskRunStore(port, projectId)
    let owner = (await store.loadTask(taskId))?.task
    if (!owner) {
      owner = runAction(createTask({ id: taskId, projectId, title: 'Guarded action task', description: 'Host-owned action allowance.', createdAt: now() }))
      await store.createTask(owner)
    }
    let run = await store.loadRun(runId)
    if (!run) {
      run = runAction(createRun(owner, { id: runId, agentDefinitionRef: agentRef, createdAt: now(), maxSteps: task.cap }))
      await store.createRun(run)
    }
    if (run.status === 'created') {
      const started = transitionRun(owner, run, { id: `start-${runId}`, type: 'start', projectId, taskId, runId, expectedRevision: run.revision, occurredAt: now() })
      if (started.status !== 'applied') throw new Error('run-start-refused')
      await store.saveRun(started.run, run.revision)
      run = started.run
    }
    return { owner, run }
  }

  function proposal(owner: Task, run: Run, operation: Pick<Operation, 'key' | 'amount' | 'createdAt' | 'runRevision'>, input: ActionInput) {
    return runAction(validateActionProposal({ schemaVersion: 'action-proposal/v0.1', id: operationId(operation.key), revision: 1,
      projectId, taskId, runId: run.id, runRevision: operation.runRevision, agentRef, actionRef: { id: action, revision },
      input: { payload: input, amount: operation.amount, unit: task.unit, operationKey: operation.key },
      target: { kind: 'logical-operation', resource: operation.key } }, { task: owner, run, agent, definitions: [definition], createdAt: operation.createdAt }))
  }

  type ReceiptReadPort = Pick<LocalRecordPort, 'read' | 'list' | 'checksumFor'>

  async function storedApproval(value: Operation, port: ReceiptReadPort = state) {
    const registered = await port.read('proposals', operationId(value.key))
    if (!registered) return null
    const hash = port.checksumFor(value.digestVersion)
    const stored = parseStoredProposal(registered, value.digestVersion, hash)
    if (stored.binding.proposalDigest !== value.proposalDigest || hash(stored.proposal) !== value.proposalDigest
      || (value.binding && digest(stored.binding) !== digest(value.binding))) {
      throw new Error('approval-binding-conflict')
    }
    const row = await port.read('approval-requests', stored.requestId)
    if (!row) return null
    if (row.digestVersion !== value.digestVersion) throw new Error('approval-binding-conflict')
    const request = parseApprovalRequest(row.payload, stored.binding, stored.proposal, hash)
    const recorded = await port.read('approval-decisions', approvalDecisionId(request.id))
    if (recorded && recorded.digestVersion !== value.digestVersion) throw new Error('approval-binding-conflict')
    return { request, decision: recorded ? parseApprovalDecision(recorded.payload, request, hash) : null }
  }

  async function allowanceObservation(port: Pick<LocalRecordPort, 'list'>) {
    const rows = await port.list(actionAllowanceKind)
    const auditText = await audit.read()
    return { rows, hasReconciliation: hasReconciliationData(rows, auditText) }
  }

  async function lockedReconciliationView(writer: LocalLockedRecordPort) {
    if (!(await allowanceObservation(writer)).hasReconciliation) return undefined
    await writer.syncDecisionDirectory()
    const port = writer.strictHistory
    const rows = await port.list(actionAllowanceKind)
    const decisions = await readReconciliationDecisions(port, audit, projectId, rows)
    return { port, rows, decisions }
  }

  async function projectReceipt(port: ReceiptReadPort, rows: readonly LocalRecord[],
    decisions: ReadonlyMap<string, ReconciliationRecord> | undefined, key: string,
    override?: Pick<ActionReceipt, 'decision' | 'reason'>, replayed = false): Promise<ActionReceipt | null> {
    const { totals, selected } = await allowance.snapshot(port, key, decisions, rows)
    if (!selected) return null
    const { value, result } = selected
    const approval = await storedApproval(value, port)
    let decision: ActionReceipt['decision'] = 'APPROVAL_REQUIRED'
    let reason = 'exact-approval-required'
    if (value.phase === 'blocked') { decision = 'BLOCKED'; reason = value.refusalBasis?.reason ?? 'task_limit' }
    else if (result?.status === 'reconciled-effect') { decision = 'EXECUTED'; reason = result.status }
    else if (result?.status === 'reconciled-no-effect') { decision = 'BLOCKED'; reason = result.status }
    else if (result?.status === 'confirmed-success') { decision = 'EXECUTED'; reason = 'confirmed-success' }
    else if (result?.status === 'confirmed-failure' && result.effect === 'not-performed') { decision = 'BLOCKED'; reason = 'confirmed-no-effect' }
    else if (value.phase === 'held') { decision = 'UNKNOWN'; reason = 'reconciliation-required' }
    else if (approval?.decision?.decision === 'DENIED') { decision = 'BLOCKED'; reason = 'approval-denied' }
    else if (approval && now() >= approval.request.expiresAt) { decision = 'BLOCKED'; reason = 'expired' }
    return Object.freeze({ taskId: task.id, runId: value.runId, operationKey: value.key, action, unit: task.unit,
      requested: value.amount, inputDigest: value.inputDigest, proposalDigest: value.proposalDigest, ...totals,
      refusalBasis: value.refusalBasis ? Object.freeze({ ...value.refusalBasis, requested: value.amount }) : null,
      decision, reason, ...(decision === 'APPROVAL_REQUIRED' || override?.decision === 'CONFLICT' ? override : undefined),
      replayed, approvalRequestId: approval?.request.id ?? null,
      evidenceId: result && result.status !== 'unknown' ? result.evidenceRef.id : null })
  }

  async function readReceipt(key: string, override?: Pick<ActionReceipt, 'decision' | 'reason'>, replayed = false) {
    const before = await allowanceObservation(state)
    if (!before.hasReconciliation) {
      const result = await projectReceipt(state, before.rows, undefined, key, override, replayed)
      if (!(await allowanceObservation(state)).hasReconciliation) return result
    }
    // A visible revision-2 rename may be uncertain until directory sync succeeds.
    return state.exclusive(async (writer) => {
      const view = await lockedReconciliationView(writer)
      if (!view) throw new Error('invalid-reconciliation-history')
      await allowance.verifyManifest(view.port)
      return projectReceipt(view.port, view.rows, view.decisions, key, override, replayed)
    })
  }

  async function receipt(key: string, override?: Pick<ActionReceipt, 'decision' | 'reason'>, replayed = false): Promise<ActionReceipt> {
    const result = await readReceipt(key, override, replayed)
    if (!result) throw new Error('missing-task-operation')
    return result
  }

  return Object.freeze({
    async inspect(operationKey: string): Promise<ActionReceipt | null> {
      if (!localId(operationKey)) throw new Error('invalid-operation-key')
      const value = await allowance.read(state, operationKey)
      await allowance.verifyManifest(state, value ? 'existing' : 'inspect')
      return readReceipt(operationKey)
    },

    async execute(intent: Readonly<{ runId: string; operationKey: string; input: ActionInput }>): Promise<ActionReceipt> {
      const { runId, operationKey, input: supplied } = localObject(intent, ['runId', 'operationKey', 'input'])
      if (!localId(runId) || !localId(operationKey) || !supplied || typeof supplied !== 'object') throw new Error('invalid-action-intent')
      const input = copyLocalJson(supplied) as ActionInput
      if (Array.isArray(input)) throw new Error('invalid-action-intent')

      // Task metadata and the logical identity are written with the same project writer as admission.
      const prepared = await state.exclusive(async (port) => {
        await lockedReconciliationView(port)
        await allowance.verifyManifest(port, 'initialize')
        const existing = await allowance.read(port, operationKey)
        const digestVersion = existing?.digestVersion ?? currentDigestVersion
        const hash = port.checksumFor(digestVersion)
        const inputDigest = hash(input)
        if (existing && existing.inputDigest !== inputDigest) return { operation: existing, conflict: true }
        const amount = measure(input)
        if (existing && existing.amount !== amount) return { operation: existing, conflict: true }
        if (!positiveInteger(amount)) throw new Error('invalid-action-amount')
        if (existing && (existing.phase !== 'pending' || existing.runId !== runId || await port.read('proposals', operationId(operationKey)))) {
          return { operation: existing }
        }
        const context = await workflow(port, nativeRunId(runId))
        if (getRunNextAction(context.run) !== 'continue' || now() >= task.expiresAt) throw new Error('run-not-ready')
        const initial = existing ?? { digestVersion, key: operationKey, runId, amount, createdAt: now(), runRevision: context.run.revision,
          inputDigest, phase: 'pending' as const, binding: null }
        const actionProposal = proposal(context.owner, context.run, initial, input)
        const operation = { ...initial, proposalDigest: hash(actionProposal) }
        if (existing && existing.proposalDigest !== operation.proposalDigest) throw new Error('operation-proposal-conflict')
        if (!existing) await allowance.register(port, operation)
        return { operation, actionProposal }
      })

      const value = prepared.operation
      if (prepared.conflict) return receipt(operationKey, { decision: 'CONFLICT', reason: 'operation-conflict' })
      if (value.phase !== 'pending') return receipt(operationKey, undefined, true)
      const prior = await storedApproval(value)
      if (prior?.decision?.decision === 'DENIED') return receipt(operationKey, undefined, true)
      if (value.runId !== runId) return receipt(operationKey, { decision: 'BLOCKED', reason: 'operation-bound-to-original-run' })

      const { digestVersion } = value
      const hash = state.checksumFor(digestVersion)
      let endorsed: { digest: string; decision: Exclude<Decision, 'PENDING'> } | undefined
      const matches = (request: ExactApprovalRequest) => endorsed?.digest === hash(request)
      const gateway = createTrustedExecutionGateway({
        digestVersion,
        scope: { id: `scope-${hash(manifest)}`, revision: 1, projectId, taskId, runId: nativeRunId(runId), agentRef, expiresAt: task.expiresAt },
        state, audit, agent, approverIds: [approverId], approvalLifetimeMs: 300_000, adapterTimeoutMs: timeoutMs,
        host: {
          actorId: agentRef.id, now, scopeIsCurrent: () => true,
          actionIsInScope: (item) => item.id === operationId(value.key) && hash(item) === value.proposalDigest,
          captureDecision: async (request) => {
            if (!endorsed || !matches(request)) throw new ExecutionGatewayError('invalid-approval')
            return { approverId, decision: endorsed.decision }
          },
          verifyStoredDecision: (decision, request) => matches(request) && decision.approverId === approverId && decision.decision === endorsed?.decision,
        },
        admit: async (port, binding) => allowance.reserve(port, value.key, binding, digestVersion, await lockedReconciliationView(port)),
        actions: [{ definition, profile, adapter: {
          id: 'action-gateway-local-handler', revision,
          invoke: async (context) => {
            if (context.signal.aborted || !context.isAuthorized(context.authority, context.executionIdentity, context.proposalDigest)) return { status: 'unknown' }
            const result = await handler(context.proposal.input.payload as ActionInput, context.signal)
            if (!result || result.outcome === 'unknown' || !localId(result.evidenceId)) return { status: 'unknown' }
            const evidenceRef = { id: result.evidenceId, revision: 1 }
            if (result.outcome === 'executed') return { status: 'confirmed-success', evidenceRef }
            if (result.outcome === 'no-effect') return { status: 'confirmed-failure', effect: 'not-performed', evidenceRef }
            return { status: 'unknown' }
          },
        } }],
      })
      const id = operationId(value.key)
      try {
        if (prepared.actionProposal) await gateway.registerProposal(prepared.actionProposal)
        const request = await gateway.requestApproval(id)
        const requestDigest = hash(request)
        const decision = await review(Object.freeze({ taskId: task.id, runId, operationKey, action,
          input: request.proposal.input.payload as ActionInput, amount: value.amount, unit: task.unit,
          cap: task.cap, requestId: request.id, requestDigest, expiresAt: request.expiresAt }))
        if (decision === 'PENDING') return receipt(operationKey)
        if (decision !== 'APPROVED' && decision !== 'DENIED') throw new ExecutionGatewayError('invalid-approval')
        if (prior?.decision && prior.decision.decision !== decision) throw new ExecutionGatewayError('invalid-approval')
        endorsed = { digest: requestDigest, decision }
        if (!prior?.decision) await gateway.captureApproval(request.id)
        if (decision === 'DENIED') return receipt(operationKey)
        const result = await gateway.execute(id)
        const latest = (await allowance.read(state, operationKey))!
        if (latest.phase === 'pending') {
          return receipt(operationKey, { decision: result.status === 'execution_unknown' ? 'UNKNOWN' : 'BLOCKED', reason: result.code })
        }
        return receipt(operationKey)
      } catch (error) {
        const latest = (await allowance.read(state, operationKey))!
        if (latest.phase !== 'pending') return receipt(operationKey, undefined, true)
        return receipt(operationKey, { decision: 'BLOCKED', reason: error instanceof ExecutionGatewayError ? error.code : 'storage-or-review-failure' })
      }
    },
  })
}
