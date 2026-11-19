export type PolicyDecision = 'allow' | 'requires-approval' | 'block';
/*! Adapted from Leonardo Tales Policy Engine (Apache-2.0). Removed the unused rule catalog and optional profiles. See LICENSES/Apache-2.0.txt. */
declare const riskLevels: readonly ["low", "medium", "high", "restricted"];
declare const subjectTypes: readonly ["agent-task", "work-order", "tool-action", "release-action", "memory-action"];
declare const permissionTiers: readonly [0, 1, 2, 3, 4, 5];
export type PolicyRiskLevel = (typeof riskLevels)[number];
export type PolicySubjectType = (typeof subjectTypes)[number];
export type PolicyPermissionTier = (typeof permissionTiers)[number];
export type PolicyEvaluationInput = {
    subjectType: PolicySubjectType;
    title: string;
    description: string;
    /** Free descriptive text; structured fields alone determine the policy classification. */
    requestedAction: string;
    permissionTier: PolicyPermissionTier;
    riskHints: PolicyRiskLevel[];
    involvesSecrets: boolean;
    involvesProduction: boolean;
    involvesExternalIntegration: boolean;
    involvesRealUserData: boolean;
    involvesFinancialOrLegalOrHealthData: boolean;
    proposesCommitOrPush: boolean;
    proposesDeployment: boolean;
    proposesPublicClaim: boolean;
    /** Caller assertion only; no human identity, signature, authority, or approval freshness is verified. */
    humanApprovalPresent: boolean;
};
export type PolicyViolation = {
    id: string;
    title: string;
    riskLevel: PolicyRiskLevel;
    description: string;
    blocking: boolean;
};
export type PolicyApprovalRequirement = {
    id: string;
    title: string;
    riskLevel: PolicyRiskLevel;
    description: string;
    satisfied: boolean;
};
export type PolicyEvaluationResult = {
    decision: PolicyDecision;
    riskLevel: PolicyRiskLevel;
    reasons: string[];
    violations: PolicyViolation[];
    approvalRequirements: PolicyApprovalRequirement[];
    auditRequired: boolean;
    boundaryNotes: string[];
};
export declare const policyEngineBoundaryNotes: string[];
/** Evaluation only: an allow result does not execute an action or grant OS, publication, or deployment permission. */
export declare function evaluatePolicy(input: PolicyEvaluationInput): PolicyEvaluationResult;
export {};
