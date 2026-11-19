import { evaluatePolicy } from './base-policy.js';
import { copyLocalJson, localId, localObject, localRevision } from './local-store.js';
import { ExecutionGatewayError } from './gateway-contract.js';
const flagKeys = ['involvesSecrets', 'involvesProduction', 'involvesExternalIntegration', 'involvesRealUserData',
    'involvesFinancialOrLegalOrHealthData', 'proposesCommitOrPush', 'proposesDeployment', 'proposesPublicClaim'];
export function policyInput(proposal, profile, humanApprovalPresent) {
    localObject(profile, ['id', 'revision', 'permissionTier', 'flags']);
    const flags = localObject(profile.flags, flagKeys);
    if (!localId(profile.id) || !localRevision(profile.revision) || ![0, 1, 2, 3, 4, 5].includes(profile.permissionTier)
        || Object.values(flags).some((value) => typeof value !== 'boolean')
        || (proposal.target.kind === 'public-source' && flags.involvesExternalIntegration !== true))
        throw new ExecutionGatewayError('invalid-policy');
    return { subjectType: 'tool-action', title: proposal.actionRef.id, description: 'Trusted registered action proposal.',
        requestedAction: proposal.actionRef.id, permissionTier: profile.permissionTier,
        riskHints: [proposal.riskContext.riskLevel], ...profile.flags, humanApprovalPresent };
}
/** Calls the existing evaluator, not another policy implementation. No supplied verdict is accepted. */
export function assessPolicy(proposal, profile, humanApprovalPresent) {
    try {
        const evaluated = evaluatePolicy(policyInput(proposal, profile, humanApprovalPresent));
        const result = localObject(copyLocalJson(evaluated), ['decision', 'riskLevel', 'reasons', 'violations', 'approvalRequirements', 'auditRequired', 'boundaryNotes']);
        if (!['allow', 'requires-approval', 'block'].includes(result.decision)
            || !['low', 'medium', 'high', 'restricted'].includes(result.riskLevel)
            || typeof result.auditRequired !== 'boolean' || !Array.isArray(result.reasons) || !result.reasons.every((v) => typeof v === 'string')
            || !Array.isArray(result.boundaryNotes) || !result.boundaryNotes.every((v) => typeof v === 'string')
            || !Array.isArray(result.violations) || !Array.isArray(result.approvalRequirements))
            throw new Error();
        for (const value of result.violations) {
            const rule = localObject(value, ['id', 'title', 'riskLevel', 'description', 'blocking']);
            if (!validRule(rule) || typeof rule.blocking !== 'boolean' || (result.decision === 'allow' && rule.blocking))
                throw new Error();
        }
        for (const value of result.approvalRequirements) {
            const rule = localObject(value, ['id', 'title', 'riskLevel', 'description', 'satisfied']);
            if (!validRule(rule) || typeof rule.satisfied !== 'boolean' || (result.decision === 'allow' && !rule.satisfied))
                throw new Error();
        }
        return result;
    }
    catch {
        throw new ExecutionGatewayError('invalid-policy');
    }
}
function validRule(rule) {
    return typeof rule.id === 'string' && typeof rule.title === 'string' && typeof rule.description === 'string'
        && ['low', 'medium', 'high', 'restricted'].includes(rule.riskLevel);
}
