import { type ProjectId, type Run, type RunId, type RunReference, type Task, type TaskId } from './task-run.js';
export type ActionInputValue = string | number | boolean | null | readonly ActionInputValue[] | {
    readonly [key: string]: ActionInputValue;
};
export type ActionInput = Readonly<Record<string, ActionInputValue>>;
export type ActionInputField = Readonly<{
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    required: boolean;
}>;
/** Trusted operation metadata, not a policy decision, permission grant or handler. */
export type ActionDefinition = Readonly<{
    id: string;
    revision: number;
    category: string;
    description: string;
    requiredCapability: string;
    inputFields: Readonly<Record<string, ActionInputField>>;
    targetKind: string;
    targetInputField?: string;
    riskLevel: 'low' | 'medium' | 'high' | 'restricted';
    sideEffect: 'none' | 'read' | 'create' | 'update' | 'delete' | 'execute';
    auditRequired: boolean;
    approvalMayBeRequired: boolean;
    executionAvailable: false;
}>;
/** Proposed resource identity; actual URL/path/data-scope checks belong to the future runtime. */
export type ActionTarget = Readonly<{
    kind: string;
    resource: string;
}>;
/** Untrusted intent, with caller-chosen identity. It contains no claimed authority or risk flags. */
export type ActionProposalInput = Readonly<{
    schemaVersion: 'action-proposal/v0.1';
    id: string;
    revision: number;
    projectId: ProjectId;
    taskId: TaskId;
    runId: RunId;
    runRevision: number;
    agentRef: RunReference;
    actionRef: RunReference;
    input: ActionInput;
    target: ActionTarget;
}>;
/** Structurally consistent proposal only; it is still subject to future runtime checks. */
export type ActionProposal = ActionProposalInput & Readonly<{
    createdAt: string;
    category: string;
    riskContext: Readonly<Pick<ActionDefinition, 'riskLevel' | 'sideEffect' | 'auditRequired' | 'approvalMayBeRequired'>>;
    executionAvailable: false;
}>;
export type ActionProposalContext = Readonly<{
    task: Task;
    run: Run;
    agent: Readonly<{
        id: string;
        declarativeProfile: Readonly<{
            schemaVersion: 'agent-profile/v0.1';
            revision: number;
            executionAvailable: false;
            capabilityIds: readonly string[];
            actionIds: readonly string[];
        }>;
    }>;
    /** Code-owned definitions, selected by the trusted caller; never loaded from model output. */
    definitions: readonly ActionDefinition[];
    createdAt: string;
}>;
export type ActionProposalErrorCode = 'invalid-proposal' | 'invalid-context' | 'identity-mismatch' | 'stale-run' | 'agent-mismatch' | 'unknown-action' | 'action-version-mismatch' | 'undeclared-capability' | 'invalid-input' | 'invalid-target' | 'invalid-timestamp';
export type ActionProposalValidationResult = Readonly<{
    ok: true;
    value: ActionProposal;
}> | Readonly<{
    ok: false;
    error: ActionProposalErrorCode;
}>;
/** No policy evaluation or side effect occurs here. The result is not executable authority. */
export declare function validateActionProposal(input: unknown, context: ActionProposalContext): ActionProposalValidationResult;
