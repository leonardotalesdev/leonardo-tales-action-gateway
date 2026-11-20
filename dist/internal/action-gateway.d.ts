import { type ActionInput } from './action-contract.js';
import { type RefusalBalance } from './action-allowance.js';
type TaskSettings = Readonly<{
    id: string;
    cap: number;
    unit: string;
    expiresAt: string;
}>;
type Decision = 'APPROVED' | 'DENIED' | 'PENDING';
export type ActionReview = Readonly<{
    taskId: string;
    runId: string;
    operationKey: string;
    action: string;
    input: ActionInput;
    amount: number;
    unit: string;
    cap: number;
    requestId: string;
    requestDigest: string;
    expiresAt: string;
}>;
export type ActionOutcome = Readonly<{
    outcome: 'executed' | 'no-effect';
    evidenceId: string;
} | {
    outcome: 'unknown';
}>;
export type ActionReceipt = Readonly<{
    taskId: string;
    runId: string;
    operationKey: string;
    action: string;
    inputDigest: string;
    proposalDigest: string;
    unit: string;
    requested: number;
    cap: number;
    settled: number;
    held: number;
    remaining: number;
    refusalBasis: Readonly<RefusalBalance & {
        requested: number;
    }> | null;
    decision: 'APPROVAL_REQUIRED' | 'EXECUTED' | 'BLOCKED' | 'UNKNOWN' | 'CONFLICT';
    reason: string;
    approvalRequestId: string | null;
    evidenceId: string | null;
    replayed: boolean;
}>;
export type ActionGatewayOptions = Readonly<{
    directory: string;
    task: TaskSettings;
    tool: Readonly<{
        id: string;
        revision: number;
        amount(input: ActionInput): number;
        execute(input: ActionInput, signal: AbortSignal): Promise<ActionOutcome>;
    }>;
    approverId: string;
    review(request: ActionReview): Promise<Decision>;
    /** Original Node/ICU collation for v0.1.0 records, if different from the current default. */
    legacyDigestLocale?: string;
    now?(): string;
    timeoutMs?: number;
}>;
/** Trusted local host only. Expose a narrower input-only tool wrapper to an agent. */
export declare function createActionGateway(options: ActionGatewayOptions): Promise<Readonly<{
    inspect(operationKey: string): Promise<ActionReceipt | null>;
    execute(intent: Readonly<{
        runId: string;
        operationKey: string;
        input: ActionInput;
    }>): Promise<ActionReceipt>;
}>>;
export {};
