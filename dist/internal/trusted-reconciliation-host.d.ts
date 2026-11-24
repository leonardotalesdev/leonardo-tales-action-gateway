type EvidenceRef = Readonly<{
    id: string;
    revision: number;
}>;
export type TrustedReconciliationRequest = Readonly<{
    requestId: string;
    operationKey: string;
    evidenceRef: EvidenceRef;
}>;
export type TrustedReconciliationContext = Readonly<{
    requestId: string;
    actorId: string;
    evidenceRef: EvidenceRef;
    subject: Readonly<{
        projectId: string;
        taskId: string;
        originalTaskId: string;
        runId: string;
        originalRunId: string;
        operationKey: string;
        actionRef: Readonly<{
            id: string;
            revision: number;
        }>;
        target: Readonly<{
            kind: 'logical-operation';
            resource: string;
        }>;
        amount: number;
        unit: string;
        digestVersion: 'legacy-v0.1' | 'utf16-v1';
        inputDigest: string;
        proposalDigest: string;
        approvalRequestId: string;
        approvalRequestDigest: string;
        approvalDecisionId: string;
        attemptId: string;
        executionIdentity: string;
        subjectDigest: string;
        expectedState: string;
        storeGeneration: string;
        observedPrefix: 'reconciliation-required';
    }>;
}>;
type AssessmentBinding = Readonly<{
    requestId: string;
    actorId: string;
    evidenceRef: EvidenceRef;
    subjectDigest: string;
    expectedState: string;
}>;
type AssessmentBasis = Readonly<{
    binding: AssessmentBinding;
    /** Digest of the immutable host evidence dossier for this binding. */
    evidenceDigest: string;
    /** Original trusted assessment time, reproduced exactly on pending resume. */
    qualifiedAt: string;
}>;
/** Trusted commitments to the evidence and findings for the original attempt. */
export type TrustedReconciliationAssessment = Readonly<AssessmentBasis & {
    status: 'confirmed-effect';
    effectOccurredDigest: string;
}> | Readonly<AssessmentBasis & {
    status: 'confirmed-no-effect';
    effectAbsentDigest: string;
    attemptFinalityDigest: string;
}> | Readonly<{
    status: 'unresolved';
}>;
export type TrustedReconciliationRefusalCode = 'invalid-host-config' | 'invalid-request' | 'store-not-found' | 'unsafe-store' | 'promotion-required' | 'legacy-locale-required' | 'ineligible' | 'stale-state' | 'request-conflict' | 'attempt-conflict' | 'resolver-timeout' | 'resolver-failed' | 'invalid-assessment' | 'evidence-mismatch' | 'invalid-clock' | 'corrupt-storage' | 'store-busy' | 'write-uncertain' | 'storage-failure' | 'internal-failure';
type ReconciledOutcome = 'reconciled-effect' | 'reconciled-no-effect';
export type TrustedReconciliationReceipt = Readonly<TrustedReconciliationRequest & {
    status: 'applied';
    outcome: ReconciledOutcome;
}> | Readonly<TrustedReconciliationRequest & {
    status: 'replayed';
    outcome: ReconciledOutcome;
}> | Readonly<TrustedReconciliationRequest & {
    status: 'unresolved';
}> | Readonly<{
    status: 'refused';
    code: TrustedReconciliationRefusalCode;
}>;
/** The host authenticates the actor and controls access to this controller. */
export type TrustedReconciliationHostOptions = Readonly<{
    directory: string;
    taskId: string;
    legacyDigestLocale?: string;
    host: Readonly<{
        actorId: string;
        now: () => string;
        /** Runs outside the writer locks, with a 30-second deadline. */
        resolveEvidence: (context: TrustedReconciliationContext, signal: AbortSignal) => Promise<TrustedReconciliationAssessment>;
    }>;
}>;
export type TrustedReconciliationHost = Readonly<{
    reconcile: (request: TrustedReconciliationRequest) => Promise<TrustedReconciliationReceipt>;
}>;
/** Trusted local host only. Keep the controller outside model-facing tool registries. */
export declare function createTrustedReconciliationHost(options: TrustedReconciliationHostOptions): Promise<TrustedReconciliationHost>;
export {};
