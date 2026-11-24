import type { ActionDefinition, ActionTarget } from './action-contract.js';
import { type DigestVersion } from './digest.js';
import { type ExecutionAuditPort } from './execution-audit.js';
import type { ActionPolicyProfile, ExactActionBinding } from './gateway-contract.js';
import { type LocalRecordPort } from './local-store.js';
type ReadState = Pick<LocalRecordPort, 'read' | 'checksumFor'>;
export type ReconciliationSubject = Readonly<{
    projectId: string;
    taskId: string;
    originalTaskId: string;
    originalRunId: string;
    operationKey: string;
    digestVersion: DigestVersion;
    inputDigest: string;
    proposalDigest: string;
    binding: ExactActionBinding;
    approvalRequestId: string;
    approvalRequestDigest: string;
    approvalDecisionId: string;
    target: ActionTarget;
    amount: number;
    unit: string;
    attemptId: string;
    revisions: Readonly<{
        manifest: number;
        operation: number;
        proposal: number;
        request: number;
        decision: number;
    }>;
}>;
type Refusal = 'missing-operation' | 'not-held' | 'missing-attempt' | 'closed-attempt' | 'unsupported-prefix' | 'invalid-history';
type IneligibleSubject = Readonly<{
    status: 'ineligible';
    reason: Refusal;
}>;
type EligibleSubject = Readonly<{
    status: 'eligible';
    observedPrefix: 'reserved' | 'reconciliation-required';
    subject: ReconciliationSubject;
    subjectDigest: string;
    expectedState: string;
}>;
type SubjectResult = IneligibleSubject | EligibleSubject;
type VerifiedSubject = IneligibleSubject | Readonly<{
    status: 'eligible';
    result: EligibleSubject;
    historicalFloor: string;
    runRevision: number;
}>;
export declare const gatewayAgent: {
    id: string;
    revision: number;
};
export declare function historicalDefinition(actionRef: ExactActionBinding['actionRef']): ActionDefinition;
export declare const historicalProfile: ActionPolicyProfile;
/**
 * Read a v0.1.1 history through existing ports. Eligibility is structural even
 * if the original worker is still live. The token must be rechecked under the
 * writer by any future decision path.
 */
export declare function readReconciliationSubject(state: ReadState, audit: Pick<ExecutionAuditPort, 'read'>, projectId: string, operationKey: string): Promise<SubjectResult>;
/** With a stored witness, verify the original prefix of an intact, replay-validated Run. */
export declare function reconstructReconciliationSubject(state: ReadState, audit: Pick<ExecutionAuditPort, 'read'>, projectId: string, operationKey: string, runRevisionAtQualification?: number): Promise<VerifiedSubject>;
export {};
