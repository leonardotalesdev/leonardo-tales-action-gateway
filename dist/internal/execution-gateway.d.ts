import { type ActionProposal } from './action-contract.js';
import { type ExecutionAuditEvent } from './execution-audit.js';
import { type DigestVersion, type SnapshotChecksum } from './digest.js';
import { type LocalRecord, type LocalRecordPort } from './local-store.js';
import { type ExecutionGatewayOptions, type ExactActionBinding, type ExactApprovalDecision, type ExactApprovalRequest, type ExecutionAdapterResult, type GatewayResult } from './gateway-contract.js';
export type * from './gateway-contract.js';
type ProposalRecord = Readonly<{
    proposal: ActionProposal;
    taskRevision: number;
    binding: ExactActionBinding;
    requestId: string;
}>;
type Attempt = Readonly<{
    schemaVersion: 'gateway-attempt/v0.1';
    binding: ExactActionBinding;
    phase: 'reserved' | 'closed' | 'reconciliation-required';
    pendingEvents: readonly ExecutionAuditEvent[];
    result: ExecutionAdapterResult | null;
    createdAt: string;
}>;
export declare function parseStoredProposal(record: LocalRecord, version: DigestVersion, hash: SnapshotChecksum): ProposalRecord;
export declare function loadAttempt(port: Pick<LocalRecordPort, 'read' | 'checksumFor'>, exact: ExactActionBinding, version: DigestVersion): Promise<{
    record: LocalRecord;
    value: Attempt;
} | null>;
/** Positive terminal evidence for a particular durable reservation, never a dispatch permit. */
export declare function readClosedExecution(port: Pick<LocalRecordPort, 'read' | 'checksumFor'>, binding: ExactActionBinding, version: DigestVersion): Promise<ExecutionAdapterResult | null>;
/** Native host factory only. No model, UI, provider, credentials or real adapter is installed here. */
export declare function createTrustedExecutionGateway(options: ExecutionGatewayOptions): Readonly<{
    isExecutionAuthority: (value: unknown, identity: string, proposalDigest: string) => boolean;
    registerProposal(value: unknown): Promise<ActionProposal>;
    requestApproval(id: string): Promise<ExactApprovalRequest>;
    captureApproval(id: string): Promise<ExactApprovalDecision>;
    execute(id: string): Promise<GatewayResult>;
    /** Native recovery observation after the host establishes that the old worker was interrupted. Never dispatches. */
    recordInterrupted(id: string): Promise<GatewayResult>;
}>;
