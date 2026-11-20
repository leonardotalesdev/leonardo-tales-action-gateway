import type { DigestVersion, SnapshotChecksum } from './digest.js';
import { type LocalRecordPort } from './local-store.js';
export type ExecutionStatus = 'proposed' | 'execution_started' | 'execution_unknown' | 'reconciliation_required' | 'executed' | 'failed';
export type ExecutionBinding = Readonly<{
    projectId: string;
    taskId: string;
    runId: string;
    proposalRef: Readonly<{
        id: string;
        revision: number;
    }>;
    proposalDigest: string;
}>;
/** An observed attempt record, never a permission grant or executable capability. */
export type ExecutionState = ExecutionBinding & Readonly<{
    schemaVersion: 'execution-state/v0.1';
    id: string;
    executionIdentity: string;
    revision: number;
    status: ExecutionStatus;
    createdAt: string;
    updatedAt: string;
}>;
/** Deterministic metadata only; it neither reserves nor authorizes an attempt. */
export declare function executionStateIdentity(value: ExecutionBinding, hash: SnapshotChecksum): Readonly<{
    id: string;
    executionIdentity: string;
}>;
export declare function validateExecutionState(value: unknown, hash: SnapshotChecksum): ExecutionState;
export declare function createExecutionStateStore(port: LocalRecordPort, projectId: string, digestVersion: DigestVersion): Readonly<{
    load: (id: string) => Promise<ExecutionState | null>;
    create(value: ExecutionBinding, createdAt: string): Promise<ExecutionState>;
    /** Persist host observations only. M3 neither authorizes nor dispatches the described action. */
    recordObservation(id: string, expectedRevision: number, status: ExecutionStatus, occurredAt: string): Promise<ExecutionState>;
}>;
