import { type LocalRecord } from './local-store.js';
type OutcomeProof = Readonly<{
    outcome: 'confirmed-effect';
    proof: Readonly<{
        effectOccurredDigest: string;
    }>;
}> | Readonly<{
    outcome: 'confirmed-no-effect';
    proof: Readonly<{
        effectAbsentDigest: string;
        attemptFinalityDigest: string;
    }>;
}>;
export type Qualification = OutcomeProof & Readonly<{
    requestId: string;
    actorId: string;
    projectId: string;
    taskId: string;
    operationKey: string;
    attemptId: string;
    executionIdentity: string;
    storeGeneration: string;
    subjectDigest: string;
    expectedState: string;
    evidenceRef: Readonly<{
        id: string;
        revision: number;
    }>;
    evidenceDigest: string;
    qualifiedAt: string;
}>;
export type ReconciliationPayload = Readonly<{
    schemaVersion: 'reconciliation-decision/v1';
    qualification: Qualification;
    qualificationDigest: string;
    runRevisionAtQualification: number;
}> & (Readonly<{
    phase: 'qualified';
    appliedAt: null;
}> | Readonly<{
    phase: 'applied';
    appliedAt: string;
}>);
export type ReconciliationRecord = LocalRecord & Readonly<{
    payload: ReconciliationPayload;
}>;
export declare function normalizeQualification(value: unknown): Qualification;
type DecisionIdentity = Pick<Qualification, 'projectId' | 'taskId' | 'operationKey' | 'attemptId' | 'executionIdentity'>;
export declare function isReconciliationRecordId(id: string): boolean;
export declare function reconciliationDecisionId(q: DecisionIdentity): string;
export declare function qualificationDigest(q: Qualification): string;
export declare function reconciliationEventId(decisionId: string): string;
export declare function parseReconciliationDecision(record: LocalRecord): ReconciliationPayload;
export declare function sameQualification(a: Qualification, b: Qualification): boolean;
export {};
