import { computeSnapshotChecksum, type SnapshotChecksum } from './digest.js'
import { copyLocalJson, localId, localObject, localTimestamp } from './local-store.js'
import { ExecutionGatewayError, type ExactActionBinding, type ExactApprovalRequest, type ExactApprovalDecision } from './gateway-contract.js'
import type { ActionProposal } from './action-contract.js'

export function approvalRequestId(binding: ExactActionBinding, hash: SnapshotChecksum) { return `approval-request-${hash(binding)}` }
export function approvalDecisionId(requestId: string) { return `approval-decision-${computeSnapshotChecksum(requestId)}` }

export function makeApprovalRequest(binding: ExactActionBinding, proposal: ActionProposal, createdAt: string, expiresAt: string,
  hash: SnapshotChecksum): ExactApprovalRequest {
  return parseApprovalRequest({ schemaVersion: 'exact-approval-request/v0.1', id: approvalRequestId(binding, hash),
    binding, proposal, createdAt, expiresAt }, binding, proposal, hash)
}
export function parseApprovalRequest(value: unknown, binding: ExactActionBinding, proposal: ActionProposal,
  hash: SnapshotChecksum): ExactApprovalRequest {
  try {
    const raw = localObject(copyLocalJson(value), ['schemaVersion', 'id', 'binding', 'proposal', 'createdAt', 'expiresAt'])
    if (raw.schemaVersion !== 'exact-approval-request/v0.1' || raw.id !== approvalRequestId(binding, hash)
      // Compare the normalized content independently of its identity hash.
      || computeSnapshotChecksum(raw.binding) !== computeSnapshotChecksum(binding)
      || computeSnapshotChecksum(raw.proposal) !== computeSnapshotChecksum(proposal)
      || !localTimestamp(raw.createdAt) || !localTimestamp(raw.expiresAt) || raw.expiresAt <= raw.createdAt) throw new Error()
    return Object.freeze(raw) as unknown as ExactApprovalRequest
  } catch { throw new ExecutionGatewayError('invalid-approval') }
}
export function parseApprovalDecision(value: unknown, request: ExactApprovalRequest, hash: SnapshotChecksum): ExactApprovalDecision {
  try {
    const raw = localObject(copyLocalJson(value), ['schemaVersion', 'id', 'requestId', 'requestDigest', 'bindingDigest',
      'approverId', 'decision', 'decidedAt'])
    if (raw.schemaVersion !== 'exact-approval-decision/v0.1' || raw.id !== approvalDecisionId(request.id)
      || raw.requestId !== request.id || raw.requestDigest !== hash(request)
      || raw.bindingDigest !== hash(request.binding) || !localId(raw.approverId)
      || !['APPROVED', 'DENIED'].includes(raw.decision as string) || !localTimestamp(raw.decidedAt)
      || raw.decidedAt < request.createdAt || raw.decidedAt >= request.expiresAt) throw new Error()
    return Object.freeze(raw) as unknown as ExactApprovalDecision
  } catch { throw new ExecutionGatewayError('invalid-approval') }
}
