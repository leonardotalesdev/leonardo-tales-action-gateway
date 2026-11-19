/** Pure lifecycle metadata. No state, event or reference grants execution authority. */
export type ProjectId = `project-${string}`;
export type TaskId = `task-${string}`;
export type RunId = `run-${string}`;
export type Task = Readonly<{
    schemaVersion: 'task/v0.1';
    id: TaskId;
    projectId: ProjectId;
    title: string;
    description: string;
    createdAt: string;
}>;
/** Opaque reference only; resolving or verifying it belongs to a later trusted runtime. */
export type RunReference = Readonly<{
    id: string;
    revision: number;
}>;
export type RunCheckpoint = Readonly<{
    step: number;
    artifactIds: readonly string[];
}>;
export type RunStatus = 'created' | 'running' | 'awaiting-approval' | 'paused' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type NextAction = 'start' | 'continue' | 'await-approval' | 'resume' | 'reconcile' | 'review-result' | 'budget-exhausted' | 'none';
type RunChange = Readonly<{
    type: 'start' | 'pause' | 'resume' | 'complete' | 'fail' | 'cancel';
}> | Readonly<{
    type: 'checkpoint';
    checkpoint: RunCheckpoint;
}> | Readonly<{
    type: 'await-approval' | 'block';
    actionRef: RunReference;
}> | Readonly<{
    type: 'resolve-approval';
    actionRef: RunReference;
    approvalRef: RunReference;
    outcome: 'approved' | 'denied';
}> | Readonly<{
    type: 'reconcile';
    actionRef: RunReference;
    blockedRevision: number;
    resolution: 'resolved' | 'unresolved';
    resolutionRef: RunReference;
}>;
export type RunEvent = Readonly<{
    id: string;
    projectId: ProjectId;
    taskId: TaskId;
    runId: RunId;
    expectedRevision: number;
    occurredAt: string;
}> & RunChange;
export type Run = Readonly<{
    schemaVersion: 'run/v0.1';
    id: RunId;
    projectId: ProjectId;
    taskId: TaskId;
    agentDefinitionRef: RunReference;
    revision: number;
    status: RunStatus;
    createdAt: string;
    updatedAt: string;
    maxSteps: number;
    checkpoint: RunCheckpoint;
    pendingActionRef: RunReference | null;
    pausedFrom: 'running' | 'awaiting-approval' | null;
    /** Deduplication receipts, not an audit log or authoritative action results. */
    appliedEvents: readonly RunEvent[];
}>;
export type TaskRunErrorCode = 'invalid-identity' | 'invalid-input' | 'invalid-state' | 'invalid-timestamp' | 'invalid-revision' | 'stale-revision' | 'revision-exhausted' | 'invalid-transition' | 'terminal-run' | 'reconciliation-required' | 'approval-required' | 'budget-exhausted' | 'event-conflict';
export type TaskRunResult<T> = Readonly<{
    ok: true;
    value: T;
}> | Readonly<{
    ok: false;
    error: TaskRunErrorCode;
}>;
export type RunTransitionResult = Readonly<{
    status: 'applied' | 'duplicate';
    run: Run;
}> | Readonly<{
    status: 'rejected';
    run: Run;
    error: TaskRunErrorCode;
}>;
export declare function createTask(input: Omit<Task, 'schemaVersion'>): TaskRunResult<Task>;
export declare function createRun(task: Task, input: Readonly<{
    id: RunId;
    createdAt: string;
    agentDefinitionRef: RunReference;
    maxSteps: number;
}>): TaskRunResult<Run>;
/**
 * Trusted in-process domain inputs, not a deserialization or authorization API.
 * Reconciliation records a caller-verified observation for the exact blocked action.
 * It returns to paused; a later runtime must verify evidence and execution authority.
 */
export declare function transitionRun(task: Task, run: Run, event: RunEvent): RunTransitionResult;
/** Operational hint only; 'continue' never means permission to execute. */
export declare function getRunNextAction(run: Run): NextAction;
export {};
