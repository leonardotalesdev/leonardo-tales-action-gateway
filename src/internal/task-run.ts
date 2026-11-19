/** Pure lifecycle metadata. No state, event or reference grants execution authority. */
export type ProjectId = `project-${string}`
export type TaskId = `task-${string}`
export type RunId = `run-${string}`

export type Task = Readonly<{
  schemaVersion: 'task/v0.1'
  id: TaskId
  projectId: ProjectId
  title: string
  description: string
  createdAt: string
}>

/** Opaque reference only; resolving or verifying it belongs to a later trusted runtime. */
export type RunReference = Readonly<{ id: string; revision: number }>
export type RunCheckpoint = Readonly<{ step: number; artifactIds: readonly string[] }>
export type RunStatus =
  | 'created' | 'running' | 'awaiting-approval' | 'paused' | 'blocked'
  | 'completed' | 'failed' | 'cancelled'
export type NextAction =
  | 'start' | 'continue' | 'await-approval' | 'resume' | 'reconcile'
  | 'review-result' | 'budget-exhausted' | 'none'

type RunChange =
  | Readonly<{ type: 'start' | 'pause' | 'resume' | 'complete' | 'fail' | 'cancel' }>
  | Readonly<{ type: 'checkpoint'; checkpoint: RunCheckpoint }>
  | Readonly<{ type: 'await-approval' | 'block'; actionRef: RunReference }>
  | Readonly<{ type: 'resolve-approval'; actionRef: RunReference; approvalRef: RunReference; outcome: 'approved' | 'denied' }>
  | Readonly<{
      type: 'reconcile'
      actionRef: RunReference
      blockedRevision: number
      resolution: 'resolved' | 'unresolved'
      resolutionRef: RunReference
    }>

export type RunEvent = Readonly<{
  id: string
  projectId: ProjectId
  taskId: TaskId
  runId: RunId
  expectedRevision: number
  occurredAt: string
}> & RunChange

export type Run = Readonly<{
  schemaVersion: 'run/v0.1'
  id: RunId
  projectId: ProjectId
  taskId: TaskId
  agentDefinitionRef: RunReference
  revision: number
  status: RunStatus
  createdAt: string
  updatedAt: string
  maxSteps: number
  checkpoint: RunCheckpoint
  pendingActionRef: RunReference | null
  pausedFrom: 'running' | 'awaiting-approval' | null
  /** Deduplication receipts, not an audit log or authoritative action results. */
  appliedEvents: readonly RunEvent[]
}>

export type TaskRunErrorCode =
  | 'invalid-identity' | 'invalid-input' | 'invalid-state' | 'invalid-timestamp'
  | 'invalid-revision' | 'stale-revision' | 'revision-exhausted'
  | 'invalid-transition' | 'terminal-run' | 'reconciliation-required'
  | 'approval-required' | 'budget-exhausted' | 'event-conflict'

export type TaskRunResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: TaskRunErrorCode }>
export type RunTransitionResult =
  | Readonly<{ status: 'applied' | 'duplicate'; run: Run }>
  | Readonly<{ status: 'rejected'; run: Run; error: TaskRunErrorCode }>

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)
}

function entityId(value: unknown, prefix: string): boolean {
  return validId(value) && value.startsWith(prefix) && value.length > prefix.length
}

function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function reference(value: RunReference | null | undefined): value is RunReference {
  return !!value && validId(value.id) && revision(value.revision)
}

function checkpoint(value: RunCheckpoint | undefined): value is RunCheckpoint {
  return !!value && Number.isSafeInteger(value.step) && value.step >= 0
    && Array.isArray(value.artifactIds) && [...value.artifactIds].every(validId)
    && new Set(value.artifactIds).size === value.artifactIds.length
}

function copyReference(value: RunReference): RunReference {
  return Object.freeze({ id: value.id, revision: value.revision })
}

function copyCheckpoint(value: RunCheckpoint): RunCheckpoint {
  return Object.freeze({ step: value.step, artifactIds: Object.freeze([...value.artifactIds]) })
}

function validTask(task: Task): boolean {
  return !!task && task.schemaVersion === 'task/v0.1'
    && entityId(task.id, 'task-') && entityId(task.projectId, 'project-')
    && typeof task.title === 'string' && task.title.trim().length > 0
    && typeof task.description === 'string' && timestamp(task.createdAt)
}

export function createTask(input: Omit<Task, 'schemaVersion'>): TaskRunResult<Task> {
  if (!input || !entityId(input.id, 'task-') || !entityId(input.projectId, 'project-')) {
    return { ok: false, error: 'invalid-identity' }
  }
  if (!timestamp(input.createdAt)) return { ok: false, error: 'invalid-timestamp' }
  if (typeof input.title !== 'string' || !input.title.trim() || typeof input.description !== 'string') {
    return { ok: false, error: 'invalid-input' }
  }
  return { ok: true, value: Object.freeze({ schemaVersion: 'task/v0.1', id: input.id,
    projectId: input.projectId, title: input.title, description: input.description, createdAt: input.createdAt }) }
}

export function createRun(task: Task, input: Readonly<{
  id: RunId; createdAt: string; agentDefinitionRef: RunReference; maxSteps: number
}>): TaskRunResult<Run> {
  if (!validTask(task) || !input || !entityId(input.id, 'run-')) {
    return { ok: false, error: 'invalid-identity' }
  }
  if (!timestamp(input.createdAt) || input.createdAt < task.createdAt) {
    return { ok: false, error: 'invalid-timestamp' }
  }
  if (!reference(input.agentDefinitionRef) || !revision(input.maxSteps)) {
    return { ok: false, error: 'invalid-input' }
  }
  return { ok: true, value: Object.freeze({ schemaVersion: 'run/v0.1', id: input.id,
    projectId: task.projectId, taskId: task.id, agentDefinitionRef: copyReference(input.agentDefinitionRef),
    revision: 1, status: 'created', createdAt: input.createdAt, updatedAt: input.createdAt,
    maxSteps: input.maxSteps, checkpoint: copyCheckpoint({ step: 0, artifactIds: [] }),
    pendingActionRef: null, pausedFrom: null, appliedEvents: Object.freeze([]) }) }
}

function validRun(run: Run): boolean {
  if (!run || run.schemaVersion !== 'run/v0.1' || !entityId(run.id, 'run-')
    || !entityId(run.projectId, 'project-') || !entityId(run.taskId, 'task-')
    || !revision(run.revision) || !reference(run.agentDefinitionRef)
    || !timestamp(run.createdAt) || !timestamp(run.updatedAt) || run.updatedAt < run.createdAt
    || !revision(run.maxSteps) || !checkpoint(run.checkpoint) || run.checkpoint.step > run.maxSteps
    || !Array.isArray(run.appliedEvents)) return false
  const held = run.status === 'awaiting-approval' || run.status === 'blocked'
    || (run.status === 'paused' && run.pausedFrom === 'awaiting-approval')
  return ['created', 'running', 'awaiting-approval', 'paused', 'blocked', 'completed', 'failed', 'cancelled'].includes(run.status)
    && (held ? reference(run.pendingActionRef) : run.pendingActionRef === null)
    && (run.status === 'paused' ? ['running', 'awaiting-approval'].includes(run.pausedFrom ?? '') : run.pausedFrom === null)
}

function sameReference(left: RunReference | null, right: RunReference): boolean {
  return left?.id === right.id && left.revision === right.revision
}

/** Copy only the closed event contract; JSON comparison is independent of caller key order. */
function copyEvent(event: RunEvent): RunEvent | null {
  const common = { id: event.id, projectId: event.projectId, taskId: event.taskId,
    runId: event.runId, expectedRevision: event.expectedRevision, occurredAt: event.occurredAt }
  switch (event.type) {
    case 'start': case 'pause': case 'resume': case 'complete': case 'fail': case 'cancel':
      return Object.freeze({ ...common, type: event.type })
    case 'checkpoint':
      return checkpoint(event.checkpoint)
        ? Object.freeze({ ...common, type: event.type, checkpoint: copyCheckpoint(event.checkpoint) }) : null
    case 'await-approval': case 'block':
      return reference(event.actionRef)
        ? Object.freeze({ ...common, type: event.type, actionRef: copyReference(event.actionRef) }) : null
    case 'resolve-approval':
      return reference(event.actionRef) && reference(event.approvalRef) && ['approved', 'denied'].includes(event.outcome)
        ? Object.freeze({ ...common, type: event.type, actionRef: copyReference(event.actionRef),
          approvalRef: copyReference(event.approvalRef), outcome: event.outcome }) : null
    case 'reconcile':
      return reference(event.actionRef) && reference(event.resolutionRef) && revision(event.blockedRevision)
        && ['resolved', 'unresolved'].includes(event.resolution)
        ? Object.freeze({ ...common, type: event.type, actionRef: copyReference(event.actionRef),
          blockedRevision: event.blockedRevision, resolution: event.resolution,
          resolutionRef: copyReference(event.resolutionRef) }) : null
    default: return null
  }
}

/**
 * Trusted in-process domain inputs, not a deserialization or authorization API.
 * Reconciliation records a caller-verified observation for the exact blocked action.
 * It returns to paused; a later runtime must verify evidence and execution authority.
 */
export function transitionRun(task: Task, run: Run, event: RunEvent): RunTransitionResult {
  const reject = (error: TaskRunErrorCode): RunTransitionResult => ({ status: 'rejected', run, error })
  if (!validTask(task) || !run || !event || !entityId(event.projectId, 'project-')
    || !entityId(event.taskId, 'task-') || !entityId(event.runId, 'run-') || !validId(event.id)
    || run.taskId !== task.id || run.projectId !== task.projectId
    || event.taskId !== run.taskId || event.projectId !== run.projectId || event.runId !== run.id) {
    return reject('invalid-identity')
  }
  if (!validRun(run) || run.createdAt < task.createdAt) return reject('invalid-state')
  if (!revision(event.expectedRevision)) return reject('invalid-revision')
  if (!timestamp(event.occurredAt)) return reject('invalid-timestamp')
  const copied = copyEvent(event)
  if (!copied) return reject('invalid-input')
  const previous = run.appliedEvents.find((entry) => entry.id === event.id)
  if (previous) {
    return JSON.stringify(previous) === JSON.stringify(copied)
      ? { status: 'duplicate', run } : reject('event-conflict')
  }
  if (event.expectedRevision !== run.revision) return reject('stale-revision')
  if (['completed', 'failed', 'cancelled'].includes(run.status)) return reject('terminal-run')
  if (event.occurredAt < run.updatedAt) return reject('invalid-timestamp')
  if (run.revision === Number.MAX_SAFE_INTEGER) return reject('revision-exhausted')
  if (run.status === 'blocked' && event.type !== 'reconcile') return reject('reconciliation-required')

  let status = run.status
  let pendingActionRef = run.pendingActionRef
  let pausedFrom = run.pausedFrom
  let nextCheckpoint = run.checkpoint
  switch (event.type) {
    case 'start':
      if (status !== 'created') return reject('invalid-transition')
      status = 'running'
      break
    case 'pause':
      if (status !== 'running' && status !== 'awaiting-approval') return reject('invalid-transition')
      pausedFrom = status
      status = 'paused'
      break
    case 'resume':
      if (status !== 'paused') return reject('invalid-transition')
      if (pausedFrom === 'running' && run.checkpoint.step >= run.maxSteps) return reject('budget-exhausted')
      status = pausedFrom!
      pausedFrom = null
      break
    case 'checkpoint':
      if (status !== 'running') return reject('invalid-transition')
      if (run.checkpoint.step >= run.maxSteps) return reject('budget-exhausted')
      if (event.checkpoint.step !== run.checkpoint.step + 1
        || event.checkpoint.step > run.maxSteps
        || !run.checkpoint.artifactIds.every((id) => event.checkpoint.artifactIds.includes(id))) {
        return reject('invalid-input')
      }
      nextCheckpoint = copyCheckpoint(event.checkpoint)
      break
    case 'await-approval':
      if (status !== 'running') return reject('invalid-transition')
      if (run.checkpoint.step >= run.maxSteps) return reject('budget-exhausted')
      status = 'awaiting-approval'
      pendingActionRef = copyReference(event.actionRef)
      break
    case 'block':
      if (status !== 'running' && !(status === 'paused' && pausedFrom === 'running')) return reject('invalid-transition')
      status = 'blocked'
      pausedFrom = null
      pendingActionRef = copyReference(event.actionRef)
      break
    case 'resolve-approval':
      // Lifecycle metadata only. The trusted gateway verifies human evidence first.
      if (status !== 'awaiting-approval' || !sameReference(pendingActionRef, event.actionRef)) return reject('invalid-transition')
      status = event.outcome === 'approved' ? 'running' : 'failed'
      pendingActionRef = null
      break
    case 'reconcile':
      if (status !== 'blocked') return reject('invalid-transition')
      if (!sameReference(pendingActionRef, event.actionRef) || event.blockedRevision !== run.revision
        || event.resolution !== 'resolved') return reject('reconciliation-required')
      status = 'paused'
      pausedFrom = 'running'
      pendingActionRef = null
      break
    case 'complete': case 'fail': case 'cancel':
      if (pendingActionRef) return reject('approval-required')
      // Finishing bookkeeping remains possible after pausing at the step limit.
      if (event.type !== 'cancel' && status !== 'running'
        && !(status === 'paused' && pausedFrom === 'running')) return reject('invalid-transition')
      status = event.type === 'complete' ? 'completed' : event.type === 'fail' ? 'failed' : 'cancelled'
      pausedFrom = null
      break
    default: return reject('invalid-transition')
  }
  return { status: 'applied', run: Object.freeze({ ...run, status, pendingActionRef, pausedFrom,
    agentDefinitionRef: copyReference(run.agentDefinitionRef),
    checkpoint: copyCheckpoint(nextCheckpoint), revision: run.revision + 1, updatedAt: event.occurredAt,
    appliedEvents: Object.freeze([...run.appliedEvents, copied]) }) }
}

/** Operational hint only; 'continue' never means permission to execute. */
export function getRunNextAction(run: Run): NextAction {
  if (!validRun(run)) return 'none'
  switch (run.status) {
    case 'created': return 'start'
    case 'running': return run.checkpoint.step >= run.maxSteps ? 'budget-exhausted' : 'continue'
    case 'awaiting-approval': return 'await-approval'
    case 'paused': return run.pausedFrom === 'awaiting-approval' ? 'await-approval'
      : run.checkpoint.step >= run.maxSteps ? 'budget-exhausted' : 'resume'
    case 'blocked': return 'reconcile'
    case 'completed': return 'review-result'
    default: return 'none'
  }
}
