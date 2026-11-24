import { type ExecutionAuditPort } from './execution-audit.js';
import { type LocalRecord, type LocalRecordPort, type PairedReconciliationStore } from './local-store.js';
import { type ReconciliationRecord } from './reconciliation-record.js';
type StateReader = Pick<LocalRecordPort, 'read' | 'list' | 'checksumFor'>;
type AuditReader = Pick<ExecutionAuditPort, 'read'>;
type Refusal = 'invalid-qualification' | 'promotion-required' | 'stale-state' | 'binding-mismatch' | 'ineligible' | 'request-conflict' | 'attempt-conflict' | 'invalid-clock' | 'corrupt-record';
export declare class ReconciliationDecisionError extends Error {
    readonly code: Refusal;
    constructor(code: Refusal);
}
export declare function hasReconciliationData(rows: readonly LocalRecord[], auditText: string): boolean;
/** Callers consuming an existing decision must provide a fenced, durable state observation. */
export declare function readReconciliationDecisions(state: StateReader, audit: AuditReader, projectId: string, rows?: readonly LocalRecord[]): Promise<ReadonlyMap<string, ReconciliationRecord>>;
type QualificationHandle = Readonly<object>;
export declare function createReconciliationDecisionKernel({ store, now }: Readonly<{
    store: PairedReconciliationStore;
    now: () => string;
}>): Readonly<{
    issuer: Readonly<{
        issue: (value: unknown) => QualificationHandle;
    }>;
    adjudicator: Readonly<{
        apply: (handle: unknown) => Promise<ReconciliationRecord>;
    }>;
}>;
export {};
