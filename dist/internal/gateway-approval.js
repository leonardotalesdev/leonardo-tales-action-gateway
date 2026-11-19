import { computeSnapshotChecksum } from './digest.js';
import { copyLocalJson, localId, localObject, localTimestamp } from './local-store.js';
import { ExecutionGatewayError } from './gateway-contract.js';
export function approvalRequestId(binding) { return `approval-request-${computeSnapshotChecksum(binding)}`; }
export function approvalDecisionId(requestId) { return `approval-decision-${computeSnapshotChecksum(requestId)}`; }
export function makeApprovalRequest(binding, proposal, createdAt, expiresAt) {
    return parseApprovalRequest({ schemaVersion: 'exact-approval-request/v0.1', id: approvalRequestId(binding),
        binding, proposal, createdAt, expiresAt }, binding, proposal);
}
export function parseApprovalRequest(value, binding, proposal) {
    try {
        const raw = localObject(copyLocalJson(value), ['schemaVersion', 'id', 'binding', 'proposal', 'createdAt', 'expiresAt']);
        if (raw.schemaVersion !== 'exact-approval-request/v0.1' || raw.id !== approvalRequestId(binding)
            || computeSnapshotChecksum(raw.binding) !== computeSnapshotChecksum(binding)
            || computeSnapshotChecksum(raw.proposal) !== computeSnapshotChecksum(proposal)
            || !localTimestamp(raw.createdAt) || !localTimestamp(raw.expiresAt) || raw.expiresAt <= raw.createdAt)
            throw new Error();
        return Object.freeze(raw);
    }
    catch {
        throw new ExecutionGatewayError('invalid-approval');
    }
}
export function parseApprovalDecision(value, request) {
    try {
        const raw = localObject(copyLocalJson(value), ['schemaVersion', 'id', 'requestId', 'requestDigest', 'bindingDigest',
            'approverId', 'decision', 'decidedAt']);
        if (raw.schemaVersion !== 'exact-approval-decision/v0.1' || raw.id !== approvalDecisionId(request.id)
            || raw.requestId !== request.id || raw.requestDigest !== computeSnapshotChecksum(request)
            || raw.bindingDigest !== computeSnapshotChecksum(request.binding) || !localId(raw.approverId)
            || !['APPROVED', 'DENIED'].includes(raw.decision) || !localTimestamp(raw.decidedAt)
            || raw.decidedAt < request.createdAt || raw.decidedAt >= request.expiresAt)
            throw new Error();
        return Object.freeze(raw);
    }
    catch {
        throw new ExecutionGatewayError('invalid-approval');
    }
}
