import { type ExecutionAuditPort } from './execution-audit.js';
import { type LocalRecord, type LocalRecordPort, type PairedReconciliationStore } from './local-store.js';
import { reconstructReconciliationSubject } from './reconciliation.js';
import { type Qualification, type ReconciliationRecord } from './reconciliation-record.js';
type StateReader = Pick<LocalRecordPort, 'read' | 'list' | 'checksumFor'>;
type AuditReader = Pick<ExecutionAuditPort, 'read'>;
type EligibleSubject = Extract<Awaited<ReturnType<typeof reconstructReconciliationSubject>>, {
    status: 'eligible';
}>;
type Refusal = 'invalid-qualification' | 'promotion-required' | 'stale-state' | 'binding-mismatch' | 'ineligible' | 'request-conflict' | 'attempt-conflict' | 'invalid-clock' | 'corrupt-record' | 'store-not-found';
export declare class ReconciliationDecisionError extends Error {
    readonly code: Refusal;
    constructor(code: Refusal);
}
export declare function hasReconciliationData(rows: readonly LocalRecord[], auditText: string): boolean;
/** Callers consuming an existing decision must provide a fenced, durable state observation. */
export declare function readReconciliationDecisions(state: StateReader, audit: AuditReader, projectId: string, rows?: readonly LocalRecord[]): Promise<ReadonlyMap<string, ReconciliationRecord>>;
type QualificationHandle = Readonly<object>;
type ObservationRequest = Pick<Qualification, 'requestId' | 'actorId' | 'operationKey' | 'evidenceRef' | 'storeGeneration'>;
type Observation = Readonly<{
    status: 'replayed';
    record: ReconciliationRecord;
}> | Readonly<{
    status: 'eligible';
    result: EligibleSubject['result'];
}>;
type ApplyDisposition = Readonly<{
    status: 'applied' | 'replayed';
    record: ReconciliationRecord;
}>;
export declare function createReconciliationDecisionKernel({ store, now }: Readonly<{
    store: PairedReconciliationStore;
    now: () => string;
}>): Readonly<{
    validateStore: (originalTaskId: string) => Promise<string>;
    observe: (request: ObservationRequest) => Promise<Observation>;
    issuer: Readonly<{
        issue: (value: unknown) => QualificationHandle;
    }>;
    adjudicator: Readonly<{
        apply: (handle: unknown) => Promise<ReconciliationRecord>;
        applyWithDisposition: (handle: unknown) => Promise<ApplyDisposition>;
    }>;
}>;
export {};
