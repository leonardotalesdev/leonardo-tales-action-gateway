import { createTaskRunStore } from './task-run-store.js'
import { createRun, transitionRun, getRunNextAction, type Run, type RunEvent, type Task } from './task-run.js'
import { validateActionProposal, type ActionProposal, type ActionProposalInput } from './action-contract.js'
import { createExecutionAuditStore, validateExecutionAuditEvent, type ExecutionAuditEvent } from './execution-audit.js'
import { computeSnapshotChecksum as digest, legacyDigestVersion, type DigestVersion, type SnapshotChecksum } from './digest.js'
import { copyLocalJson, localId, localObject, localRevision, localTimestamp, type LocalRecord, type LocalRecordPort } from './local-store.js'
import { createExecutionStateStore, executionStateIdentity, validateExecutionState, type ExecutionBinding } from './execution-state.js'
import { assessPolicy, policyInput } from './gateway-policy.js'
import { approvalDecisionId, approvalRequestId, makeApprovalRequest, parseApprovalDecision, parseApprovalRequest } from './gateway-approval.js'
import {
  ExecutionGatewayError, type ExecutionGatewayOptions, type ExactActionBinding, type ExactApprovalDecision,
  type ExactApprovalRequest, type ExecutionAuthority, type ExecutionAdapterResult, type GatewayResult, type GatewayAction,
} from './gateway-contract.js'
export type * from './gateway-contract.js'

type ProposalRecord = Readonly<{ proposal: ActionProposal; taskRevision: number; binding: ExactActionBinding; requestId: string }>
type Attempt = Readonly<{
  schemaVersion: 'gateway-attempt/v0.1'; binding: ExactActionBinding; phase: 'reserved' | 'closed' | 'reconciliation-required'
  pendingEvents: readonly ExecutionAuditEvent[]; result: ExecutionAdapterResult | null; createdAt: string
}>
type RunChange<T = RunEvent> = T extends RunEvent
  ? Omit<T, 'id' | 'projectId' | 'taskId' | 'runId' | 'expectedRevision' | 'occurredAt'> : never
const inputKeys = ['schemaVersion', 'id', 'revision', 'projectId', 'taskId', 'runId', 'runRevision', 'agentRef', 'actionRef', 'input', 'target'] as const
const proposalKeys = [...inputKeys, 'createdAt', 'category', 'riskContext', 'executionAvailable'] as const
function same(left: unknown, right: unknown) { return digest(left) === digest(right) }
function fail(code: ConstructorParameters<typeof ExecutionGatewayError>[0]): never { throw new ExecutionGatewayError(code) }
function code(error: unknown) { return error instanceof ExecutionGatewayError ? error.code : 'storage-failure' }
function resultValue(value: unknown): ExecutionAdapterResult {
  try {
    const copy = copyLocalJson(value) as ExecutionAdapterResult
    if (copy?.status === 'unknown') { localObject(copy, ['status']); return copy }
    const fields = copy?.status === 'confirmed-failure' ? ['status', 'effect', 'evidenceRef'] : ['status', 'evidenceRef']
    const raw = localObject(copy, fields)
    const ref = localObject(raw.evidenceRef, ['id', 'revision'])
    if (!localId(ref.id) || !localRevision(ref.revision) || !['confirmed-success', 'confirmed-failure'].includes(raw.status as string)
      || (raw.status === 'confirmed-failure' && !['not-performed', 'terminal-no-retry'].includes(raw.effect as string))) throw new Error()
    return copy
  } catch { return Object.freeze({ status: 'unknown' }) }
}
function executionBinding(binding: ExactActionBinding): ExecutionBinding {
  return { projectId: binding.projectId, taskId: binding.taskId, runId: binding.runId,
    proposalRef: binding.proposalRef, proposalDigest: binding.proposalDigest }
}

export function parseStoredProposal(record: LocalRecord, version: DigestVersion, hash: SnapshotChecksum): ProposalRecord {
  if (record.revision !== 1 || record.digestVersion !== version) fail('invalid-proposal')
  const payload = record.payload as { schemaVersion?: unknown } | null
  const legacy = payload?.schemaVersion === 'gateway-proposal/v0.1'
  if (legacy ? version !== legacyDigestVersion : payload?.schemaVersion !== 'gateway-proposal/v0.2') fail('invalid-proposal')
  const keys = ['schemaVersion', 'proposal', 'taskRevision', 'binding']
  const raw = localObject(payload, legacy ? keys : [...keys, 'requestId'])
  const { proposal, taskRevision, binding } = raw as unknown as Omit<ProposalRecord, 'requestId'>
  if (!localRevision(taskRevision) || proposal?.id !== record.id) fail('invalid-proposal')
  const requestId = approvalRequestId(binding, hash)
  // An upgraded proposal pins the lookup so collation drift cannot orphan a prior request.
  if (!legacy && raw.requestId !== requestId) fail('invalid-approval')
  return { proposal, taskRevision, binding, requestId }
}

function parseAttempt(record: LocalRecord, projectId: string, hash: SnapshotChecksum) {
  const raw = localObject(record.payload, ['schemaVersion', 'binding', 'phase', 'pendingEvents', 'result', 'createdAt'])
  const bound = localObject(raw.binding, ['projectId', 'taskId', 'runId', 'taskRevision', 'baseRunRevision', 'agentRef',
    'proposalRef', 'actionRef', 'proposalDigest', 'definitionDigest', 'policyProfileRef', 'policyInputDigest',
    'adapterRef', 'scopeDigest', 'executionId', 'executionIdentity'])
  const exact = bound as unknown as ExactActionBinding
  for (const name of ['agentRef', 'proposalRef', 'actionRef', 'policyProfileRef', 'adapterRef']) {
    const ref = localObject(bound[name], ['id', 'revision'])
    if (!localId(ref.id) || !localRevision(ref.revision)) fail('invalid-record')
  }
  const identity = executionStateIdentity(executionBinding(exact), hash)
  if (raw.schemaVersion !== 'gateway-attempt/v0.1' || record.projectId !== projectId || exact.projectId !== projectId
    || record.id !== identity.id || exact.executionId !== identity.id || exact.executionIdentity !== identity.executionIdentity
    || !localRevision(exact.taskRevision) || !localRevision(exact.baseRunRevision)
    || [exact.definitionDigest, exact.policyInputDigest, exact.scopeDigest].some((value) => !/^[a-f0-9]{64}$/.test(value))
    || !['reserved', 'closed', 'reconciliation-required'].includes(raw.phase as string)
    || !localTimestamp(raw.createdAt) || !Array.isArray(raw.pendingEvents)) fail('invalid-record')
  for (const value of raw.pendingEvents) {
    const item = validateExecutionAuditEvent(value)
    if (item.projectId !== exact.projectId || item.taskId !== exact.taskId || item.runId !== exact.runId) fail('invalid-record')
  }
  if (raw.result !== null && !same(resultValue(raw.result), raw.result)) fail('invalid-record')
  if (raw.phase === 'closed' && (!raw.result || resultValue(raw.result).status === 'unknown' || raw.pendingEvents.length !== 0)) fail('invalid-record')
  return { record, value: raw as unknown as Attempt }
}
export async function loadAttempt(port: Pick<LocalRecordPort, 'read' | 'checksumFor'>, exact: ExactActionBinding, version: DigestVersion) {
  const record = await port.read('gateway-attempts', exact.executionId)
  if (!record) return null
  if (record.digestVersion !== version) fail('invalid-record')
  const parsed = parseAttempt(record, exact.projectId, port.checksumFor(version))
  if (!same(parsed.value.binding, exact)) fail('invalid-record')
  return parsed
}

/** Positive terminal evidence for a particular durable reservation, never a dispatch permit. */
export async function readClosedExecution(port: LocalRecordPort, binding: ExactActionBinding, version: DigestVersion) {
  const attempt = await loadAttempt(port, binding, version)
  return attempt?.value.phase === 'closed' ? attempt.value.result : null
}

/** Native host factory only. No model, UI, provider, credentials or real adapter is installed here. */
export function createTrustedExecutionGateway(options: ExecutionGatewayOptions) {
  const scope = copyLocalJson(options.scope) as ExecutionGatewayOptions['scope']
  const agent = copyLocalJson(options.agent) as ExecutionGatewayOptions['agent']
  const approvers = copyLocalJson(options.approverIds) as readonly string[]
  const host = options.host
  const state = options.state
  const { digestVersion } = options
  const hash = state.checksumFor(digestVersion)
  const admit = options.admit
  const audit = createExecutionAuditStore(options.audit, scope.projectId)
  const actions = options.actions.map((item): GatewayAction => Object.freeze({
    definition: copyLocalJson(item.definition) as GatewayAction['definition'],
    profile: copyLocalJson(item.profile) as GatewayAction['profile'],
    adapter: Object.freeze({ id: item.adapter.id, revision: item.adapter.revision, invoke: item.adapter.invoke }),
  }))
  const nativeDecisions = new Map<string, string>()
  const authorities = new WeakMap<object, { identity: string; digest: string }>()
  let lastObservedTime: string | undefined
  localObject(scope, ['id', 'revision', 'projectId', 'taskId', 'runId', 'agentRef', 'expiresAt'])
  localObject(scope.agentRef, ['id', 'revision'])
  if (!localId(scope.id) || !localRevision(scope.revision) || !localTimestamp(scope.expiresAt)
    || !localId(scope.agentRef.id) || !localRevision(scope.agentRef.revision)
    || !localId(scope.projectId) || !localId(scope.taskId) || !localId(scope.runId)
    || typeof host.now !== 'function' || typeof host.scopeIsCurrent !== 'function' || typeof host.actionIsInScope !== 'function'
    || !localId(host.actorId) || !approvers.every(localId) || new Set(approvers).size !== approvers.length
    || !Number.isSafeInteger(options.approvalLifetimeMs) || options.approvalLifetimeMs < 1 || options.approvalLifetimeMs > 300_000
    || !Number.isSafeInteger(options.adapterTimeoutMs) || options.adapterTimeoutMs < 1 || options.adapterTimeoutMs > 30_000
    || new Set(actions.map((item) => item.definition.id)).size !== actions.length
    || actions.some((item) => !localId(item.adapter.id) || !localRevision(item.adapter.revision) || typeof item.adapter.invoke !== 'function')) fail('invalid-record')

  function now(): string {
    const value = host.now()
    if (!localTimestamp(value) || (lastObservedTime !== undefined && value < lastObservedTime)) fail('expired')
    lastObservedTime = value
    return value
  }
  function current() {
    if (now() >= scope.expiresAt) fail('expired')
    if (host.scopeIsCurrent(scope) !== true) fail('scope-denied')
  }
  function actionCurrent(proposal: ActionProposal) {
    current()
    if (host.actionIsInScope(proposal) !== true) fail('scope-denied')
  }
  function isAuthority(value: unknown, identity: string, proposalDigest: string): boolean {
    if (!value || typeof value !== 'object') return false
    const stored = authorities.get(value)
    return !!stored && stored.identity === identity && stored.digest === proposalDigest
  }
  function reference(proposal: ActionProposal) { return { id: proposal.id, revision: proposal.revision } }
  async function workflow(port: LocalRecordPort) {
    const store = createTaskRunStore(port, scope.projectId as Task['projectId'])
    const task = await store.loadTask(scope.taskId as Task['id'])
    const run = await store.loadRun(scope.runId as Run['id'])
    if (!task || !run || !same(run.agentDefinitionRef, scope.agentRef)) fail('stale-context')
    return { store, task, run }
  }
  function baseRun(task: Task, run: Run, revision: number): Run {
    const created = createRun(task, { id: run.id, createdAt: run.createdAt, maxSteps: run.maxSteps, agentDefinitionRef: run.agentDefinitionRef })
    if (!created.ok || !localRevision(revision) || revision > run.revision) fail('stale-context')
    let base = created.value
    for (const event of run.appliedEvents.slice(0, revision - 1)) {
      const next = transitionRun(task, base, event)
      if (next.status !== 'applied') fail('stale-context')
      base = next.run
    }
    return base
  }
  function normalize(value: unknown, task: Task, run: Run): ActionProposal {
    try {
      const raw = localObject(copyLocalJson(value), proposalKeys)
      if (!localTimestamp(raw.createdAt) || raw.createdAt > now()) fail('invalid-proposal')
      const input = Object.fromEntries(inputKeys.map((key) => [key, raw[key]])) as ActionProposalInput
      const checked = validateActionProposal(input, { task, run, agent, definitions: actions.map((item) => item.definition), createdAt: raw.createdAt })
      if (!checked.ok || !same(checked.value, raw)) fail('invalid-proposal')
      return checked.value
    } catch { fail('invalid-proposal') }
  }
  function registration(proposal: ActionProposal) {
    const action = actions.find((item) => item.definition.id === proposal.actionRef.id)
    if (!action || action.definition.revision !== proposal.actionRef.revision) fail('invalid-proposal')
    return action
  }
  function binding(proposal: ActionProposal, taskRevision: number): ExactActionBinding {
    const action = registration(proposal)
    const scopeBinding: ExecutionBinding = { projectId: proposal.projectId, taskId: proposal.taskId, runId: proposal.runId,
      proposalRef: reference(proposal), proposalDigest: hash(proposal) }
    const identity = executionStateIdentity(scopeBinding, hash)
    return copyLocalJson({ projectId: scope.projectId, taskId: scope.taskId, runId: scope.runId,
      taskRevision, baseRunRevision: proposal.runRevision, agentRef: proposal.agentRef, proposalRef: reference(proposal),
      actionRef: proposal.actionRef, proposalDigest: scopeBinding.proposalDigest, definitionDigest: hash(action.definition),
      policyProfileRef: { id: action.profile.id, revision: action.profile.revision }, policyInputDigest: hash(policyInput(proposal, action.profile, false)),
      adapterRef: { id: action.adapter.id, revision: action.adapter.revision }, scopeDigest: hash({ scope, approvers }),
      executionId: identity.id, executionIdentity: identity.executionIdentity }) as ExactActionBinding
  }
  async function entry(port: LocalRecordPort, id: string): Promise<ProposalRecord> {
    const record = await port.read('proposals', id)
    if (!record) fail('invalid-proposal')
    return parseStoredProposal(record, digestVersion, hash)
  }
  async function validateCurrent(port: LocalRecordPort, stored: ProposalRecord) {
    current()
    const work = await workflow(port)
    if (work.task.revision !== stored.taskRevision) fail('stale-context')
    const base = baseRun(work.task.task, work.run, stored.proposal.runRevision)
    const proposal = normalize(stored.proposal, work.task.task, base)
    actionCurrent(proposal)
    const exact = binding(proposal, work.task.revision)
    if (!same(exact, stored.binding)) fail('stale-context')
    const tail = work.run.appliedEvents.slice(base.appliedEvents.length)
    const decisionId = approvalDecisionId(stored.requestId)
    if (tail.length > 2 || tail.some((event, index) => index === 0
      ? event.type !== 'await-approval' || !same(event.actionRef, reference(proposal))
      : event.type !== 'resolve-approval' || event.outcome !== 'approved' || !same(event.actionRef, reference(proposal))
        || !same(event.approvalRef, { id: decisionId, revision: 1 }))) fail('stale-context')
    if (!['continue', 'await-approval'].includes(getRunNextAction(work.run))) fail('run-not-ready')
    return { ...work, proposal, exact, action: registration(proposal) }
  }
  async function advance(port: LocalRecordPort, run: Run, event: RunChange, id: string) {
    const work = await workflow(port)
    const next = transitionRun(work.task.task, run, { ...event, id, projectId: run.projectId, taskId: run.taskId,
      runId: run.id, expectedRevision: run.revision, occurredAt: now() } as RunEvent)
    if (next.status !== 'applied') fail('run-not-ready')
    await work.store.saveRun(next.run, run.revision)
    return next.run
  }
  function event(proposal: ActionProposal, type: ExecutionAuditEvent['type'], observationCode: string, occurredAt: string, actorId = host.actorId): ExecutionAuditEvent {
    return validateExecutionAuditEvent({ schemaVersion: 'execution-audit-event/v0.1', id: `event-${digest([proposal.id, proposal.revision, type, observationCode])}`,
      projectId: proposal.projectId, taskId: proposal.taskId, runId: proposal.runId, type, occurredAt,
      actorId, observationCode, subjectRef: { kind: 'proposal', ...reference(proposal) } })
  }
  async function request(port: LocalRecordPort, stored: ProposalRecord): Promise<ExactApprovalRequest | null> {
    const record = await port.read('approval-requests', stored.requestId)
    if (record && record.digestVersion !== digestVersion) fail('invalid-approval')
    return record ? parseApprovalRequest(record.payload, stored.binding, stored.proposal, hash) : null
  }
  async function decision(port: LocalRecordPort, requested: ExactApprovalRequest): Promise<ExactApprovalDecision | null> {
    const record = await port.read('approval-decisions', approvalDecisionId(requested.id))
    if (record && record.digestVersion !== digestVersion) fail('invalid-approval')
    return record ? parseApprovalDecision(record.payload, requested, hash) : null
  }
  function verifyDecision(value: ExactApprovalDecision, requested: ExactApprovalRequest) {
    if (now() >= requested.expiresAt || now() < value.decidedAt) fail('expired')
    if (!approvers.includes(value.approverId)) fail('invalid-approval')
    const verified = host.verifyStoredDecision ? host.verifyStoredDecision(value, requested) === true
      : nativeDecisions.get(value.id) === hash(value)
    if (!verified) fail('invalid-approval')
    if (value.decision !== 'APPROVED') fail('approval-denied')
  }
  async function saveAttempt(port: LocalRecordPort, exact: ExactActionBinding, patch: Partial<Attempt>) {
    const current = await loadAttempt(port, exact, digestVersion)
    if (!current || current.value.phase === 'closed') fail('replay')
    await port.save({ ...current.record, revision: current.record.revision + 1, payload: { ...current.value, ...patch } }, current.record.revision)
  }
  async function otherPending(port: LocalRecordPort, exact: ExactActionBinding) {
    for (const record of await port.list('gateway-attempts')) {
      const { value } = parseAttempt(record, scope.projectId, port.checksumFor(record.digestVersion))
      if (value.binding.runId === scope.runId && record.id !== exact.executionId && value.phase !== 'closed') fail('reconciliation-required')
    }
    for (const record of await port.list('execution')) {
      const value = validateExecutionState(record.payload, port.checksumFor(record.digestVersion))
      if (record.id !== value.id || record.revision !== value.revision || value.projectId !== scope.projectId) fail('invalid-record')
      if (value.runId === scope.runId && record.id !== exact.executionId
        && ['execution_started', 'execution_unknown', 'reconciliation_required'].includes(value.status)) fail('reconciliation-required')
    }
  }
  async function approvalAdmission(port: LocalRecordPort, exact: ExactActionBinding) {
    const prior = await loadAttempt(port, exact, digestVersion)
    if (prior) fail(prior.value.phase === 'closed' ? 'replay' : 'reconciliation-required')
    await otherPending(port, exact)
  }
  async function markUnknown(port: LocalRecordPort, stored: ProposalRecord) {
    const executions = createExecutionStateStore(port, scope.projectId, digestVersion)
    let execution = await executions.load(stored.binding.executionId)
    if (execution?.status === 'proposed') execution = await executions.recordObservation(execution.id, execution.revision, 'execution_started', now())
    if (execution?.status === 'execution_started') await executions.recordObservation(execution.id, execution.revision, 'execution_unknown', now())
    const work = await workflow(port)
    if (work.run.status === 'running' || (work.run.status === 'paused' && work.run.pausedFrom === 'running')) {
      await advance(port, work.run, { type: 'block', actionRef: reference(stored.proposal) }, `block-${hash(stored.binding)}`)
    }
    const attempt = await loadAttempt(port, stored.binding, digestVersion)
    if (attempt?.value.phase === 'reserved') await saveAttempt(port, stored.binding, { phase: 'reconciliation-required' })
  }

  return Object.freeze({
    isExecutionAuthority: isAuthority,
    async registerProposal(value: unknown): Promise<ActionProposal> {
      return state.exclusive(async (port) => {
        current()
        const work = await workflow(port)
        const proposal = normalize(value, work.task.task, work.run)
        actionCurrent(proposal)
        const exact = binding(proposal, work.task.revision)
        await otherPending(port, exact)
        const stored: ProposalRecord = { proposal, taskRevision: work.task.revision, binding: exact, requestId: approvalRequestId(exact, hash) }
        const existing = await port.read('proposals', proposal.id)
        if (existing) {
          if (!same(parseStoredProposal(existing, digestVersion, hash), stored)) fail('stale-context')
          return proposal
        }
        await port.create({ kind: 'proposals', id: proposal.id, projectId: scope.projectId, revision: 1, digestVersion,
          payload: { schemaVersion: 'gateway-proposal/v0.2', ...stored } })
        return proposal
      })
    },
    async requestApproval(id: string): Promise<ExactApprovalRequest> {
      return state.exclusive(async (port) => {
        const stored = await entry(port, id)
        const checked = await validateCurrent(port, stored)
        await approvalAdmission(port, checked.exact)
        if (assessPolicy(checked.proposal, checked.action.profile, false).decision === 'block') fail('blocked-policy')
        let requested = await request(port, stored)
        if (!requested) {
          const createdAt = now()
          const expiresAt = new Date(Math.min(Date.parse(scope.expiresAt), Date.parse(createdAt) + options.approvalLifetimeMs)).toISOString()
          requested = makeApprovalRequest(checked.exact, checked.proposal, createdAt, expiresAt, hash)
          await port.create({ kind: 'approval-requests', id: requested.id, projectId: scope.projectId, revision: 1, payload: requested, digestVersion })
        }
        if (now() >= requested.expiresAt) fail('expired')
        if (checked.run.revision === checked.proposal.runRevision) {
          await advance(port, checked.run, { type: 'await-approval', actionRef: reference(checked.proposal) }, `await-${digest(requested.id)}`)
        }
        await audit.append(event(checked.proposal, 'approval-requested', 'exact-action-requested', requested.createdAt))
        return requested
      })
    },
    async captureApproval(id: string): Promise<ExactApprovalDecision> {
      const requested = await state.exclusive(async (port) => {
        current()
        const row = await port.read('approval-requests', id)
        if (!row || row.digestVersion !== digestVersion) fail('invalid-approval')
        const proposalId = (row.payload as ExactApprovalRequest)?.proposal?.id
        const stored = await entry(port, proposalId)
        const checked = await validateCurrent(port, stored)
        await approvalAdmission(port, checked.exact)
        const value = parseApprovalRequest(row.payload, stored.binding, stored.proposal, hash)
        if (now() >= value.expiresAt) fail('expired')
        return value
      })
      if (!host.captureDecision) fail('invalid-approval')
      const supplied = localObject(copyLocalJson(await host.captureDecision(requested)), ['approverId', 'decision'])
      if (!localId(supplied.approverId) || !approvers.includes(supplied.approverId)
        || !['APPROVED', 'DENIED'].includes(supplied.decision as string)) fail('invalid-approval')
      return state.exclusive(async (port) => {
        current()
        const stored = await entry(port, requested.proposal.id)
        const checked = await validateCurrent(port, stored)
        await approvalAdmission(port, checked.exact)
        const currentRequest = await request(port, stored)
        if (!currentRequest || !same(currentRequest, requested) || now() >= requested.expiresAt) fail('invalid-approval')
        const value = parseApprovalDecision({ schemaVersion: 'exact-approval-decision/v0.1', id: approvalDecisionId(requested.id),
          requestId: requested.id, requestDigest: hash(requested), bindingDigest: hash(requested.binding),
          approverId: supplied.approverId, decision: supplied.decision, decidedAt: now() }, requested, hash)
        if (await decision(port, requested)) fail('invalid-approval')
        await port.create({ kind: 'approval-decisions', id: value.id, projectId: scope.projectId, revision: 1, payload: value, digestVersion })
        nativeDecisions.set(value.id, hash(value))
        if (checked.run.status === 'awaiting-approval') {
          await advance(port, checked.run, { type: 'resolve-approval', actionRef: reference(checked.proposal),
            approvalRef: { id: value.id, revision: 1 }, outcome: value.decision === 'APPROVED' ? 'approved' : 'denied' }, `resolve-${digest(value.id)}`)
        }
        await audit.append(event(checked.proposal, 'approval-recorded', value.decision === 'APPROVED' ? 'exact-action-approved' : 'exact-action-denied', value.decidedAt, value.approverId))
        return value
      })
    },
    async execute(id: string): Promise<GatewayResult> {
      let stored: ProposalRecord | undefined
      let token: ExecutionAuthority | undefined
      let reservationCreated = false
      try {
        const prepared = await state.exclusive(async (port) => {
          stored = await entry(port, id)
          const prior = await loadAttempt(port, stored.binding, digestVersion)
          if (prior) {
            if (prior.value.phase !== 'closed') fail('reconciliation-required')
            fail('replay')
          }
          const checked = await validateCurrent(port, stored)
          await otherPending(port, checked.exact)
          const baseline = assessPolicy(checked.proposal, checked.action.profile, false)
          if (baseline.decision === 'block') fail('blocked-policy')
          const requested = await request(port, stored)
          const approved = requested ? await decision(port, requested) : null
          const needsApproval = baseline.decision === 'requires-approval' || !!requested || checked.run.status === 'awaiting-approval'
          if (needsApproval) {
            if (!requested || !approved) fail('approval-required')
            verifyDecision(approved, requested)
          }
          if (assessPolicy(checked.proposal, checked.action.profile, !!approved).decision !== 'allow') fail('blocked-policy')
          if (admit && await admit(port, checked.exact) !== true) fail('task-limit')
          let run = checked.run
          if (run.status === 'awaiting-approval') {
            if (!approved) fail('approval-required')
            run = await advance(port, run, { type: 'resolve-approval', actionRef: reference(checked.proposal),
              approvalRef: { id: approved.id, revision: 1 }, outcome: 'approved' }, `resolve-${digest(approved.id)}`)
          }
          const executions = createExecutionStateStore(port, scope.projectId, digestVersion)
          let execution = await executions.load(checked.exact.executionId)
          if (execution && execution.status !== 'proposed') fail(execution.status === 'execution_unknown' || execution.status === 'reconciliation_required' ? 'reconciliation-required' : 'replay')
          if (!execution) execution = await executions.create(executionBinding(checked.exact), now())
          if (execution.proposalDigest !== checked.exact.proposalDigest || execution.executionIdentity !== checked.exact.executionIdentity) fail('stale-context')
          const occurredAt = now()
          const pendingEvents = [event(checked.proposal, 'action-proposed', 'registered-proposal', checked.proposal.createdAt),
            event(checked.proposal, 'policy-evaluated', approved ? 'exact-approval-policy-allow' : 'policy-allow', occurredAt),
            ...(requested && approved ? [event(checked.proposal, 'approval-requested', 'exact-action-requested', requested.createdAt),
              event(checked.proposal, 'approval-recorded', 'exact-action-approved', approved.decidedAt, approved.approverId)] : []),
            event(checked.proposal, 'execution-started', 'reserved-before-adapter', occurredAt)]
          const attempt: Attempt = { schemaVersion: 'gateway-attempt/v0.1', binding: checked.exact,
            phase: 'reserved', pendingEvents, result: null, createdAt: occurredAt }
          await port.create({ kind: 'gateway-attempts', id: execution.id, projectId: scope.projectId, revision: 1, payload: attempt, digestVersion })
          reservationCreated = true
          await executions.recordObservation(execution.id, 1, 'execution_started', occurredAt)
          for (const value of pendingEvents) await audit.append(value)
          await saveAttempt(port, checked.exact, { pendingEvents: [] })
          actionCurrent(checked.proposal)
          if (requested && approved) verifyDecision(approved, requested)
          token = Object.freeze({ kind: 'execution-authority', executionIdentity: execution.executionIdentity,
            proposalDigest: checked.exact.proposalDigest }) as ExecutionAuthority
          authorities.set(token, { identity: execution.executionIdentity, digest: checked.exact.proposalDigest })
          await audit.append(event(checked.proposal, 'execution-authority-granted', 'ephemeral-permit-created', now()))
          return { checked, run, requested, approved, execution }
        })
        actionCurrent(prepared.checked.proposal)
        if (prepared.requested && prepared.approved) verifyDecision(prepared.approved, prepared.requested)
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        let observed: ExecutionAdapterResult
        try {
          const result = prepared.checked.action.adapter.invoke(Object.freeze({ proposal: prepared.checked.proposal,
            executionIdentity: prepared.execution.executionIdentity, proposalDigest: prepared.checked.exact.proposalDigest,
            authority: token!, signal: controller.signal, isAuthorized: isAuthority }))
          observed = resultValue(await Promise.race([result, new Promise<ExecutionAdapterResult>((resolve) => {
            timer = setTimeout(() => { controller.abort(); resolve({ status: 'unknown' }) }, options.adapterTimeoutMs)
          })]))
        } catch { observed = { status: 'unknown' } }
        finally { if (timer) clearTimeout(timer); if (token) authorities.delete(token) }
        if (observed.status === 'unknown') {
          await state.exclusive(async (port) => {
            await markUnknown(port, stored!)
            await audit.append(event(stored!.proposal, 'execution-result-recorded', 'execution-unknown', now()))
          })
          return { status: 'execution_unknown', code: 'adapter-ambiguous', executionId: stored!.binding.executionId }
        }
        await state.exclusive(async (port) => {
          await saveAttempt(port, stored!.binding, { result: observed })
          const executions = createExecutionStateStore(port, scope.projectId, digestVersion)
          await executions.recordObservation(stored!.binding.executionId, 2, observed.status === 'confirmed-success' ? 'executed' : 'failed', now())
          const work = await workflow(port)
          if (work.run.revision !== prepared.run.revision || work.task.revision !== stored!.taskRevision) fail('stale-context')
          await advance(port, work.run, observed.status === 'confirmed-success'
            ? { type: 'checkpoint', checkpoint: { step: work.run.checkpoint.step + 1, artifactIds: work.run.checkpoint.artifactIds } }
            : { type: 'fail' }, `result-${hash(stored!.binding)}`)
          await audit.append(event(stored!.proposal, 'execution-result-recorded', observed.status, now()))
          await saveAttempt(port, stored!.binding, { phase: 'closed', pendingEvents: [] })
        })
        return { status: observed.status === 'confirmed-success' ? 'executed' : 'failed', code: observed.status,
          executionId: stored!.binding.executionId }
      } catch (error) {
        if (token) authorities.delete(token)
        if (stored && reservationCreated) {
          try { await state.exclusive((port) => markUnknown(port, stored!)) } catch { /* Durable reservation still blocks all replay. */ }
          return { status: 'execution_unknown', code: code(error), executionId: stored.binding.executionId }
        }
        return { status: code(error) === 'reconciliation-required' ? 'execution_unknown' : 'refused', code: code(error),
          ...(stored ? { executionId: stored.binding.executionId } : {}) }
      }
    },
    /** Native recovery observation after the host establishes that the old worker was interrupted. Never dispatches. */
    async recordInterrupted(id: string): Promise<GatewayResult> {
      return state.exclusive(async (port) => {
        const stored = await entry(port, id)
        const attempt = await loadAttempt(port, stored.binding, digestVersion)
        if (!attempt || attempt.value.phase === 'closed') fail('replay')
        await markUnknown(port, stored)
        await audit.append(event(stored.proposal, 'reconciliation-started', 'interrupted-worker-no-retry', now()))
        return { status: 'execution_unknown', code: 'reconciliation-required', executionId: stored.binding.executionId }
      })
    },
  })
}
