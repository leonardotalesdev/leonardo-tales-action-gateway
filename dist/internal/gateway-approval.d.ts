import { type SnapshotChecksum } from './digest.js';
import { type ExactActionBinding, type ExactApprovalRequest, type ExactApprovalDecision } from './gateway-contract.js';
import type { ActionProposal } from './action-contract.js';
export declare function approvalRequestId(binding: ExactActionBinding, hash: SnapshotChecksum): string;
export declare function approvalDecisionId(requestId: string): string;
export declare function makeApprovalRequest(binding: ExactActionBinding, proposal: ActionProposal, createdAt: string, expiresAt: string, hash: SnapshotChecksum): ExactApprovalRequest;
export declare function parseApprovalRequest(value: unknown, binding: ExactActionBinding, proposal: ActionProposal, hash: SnapshotChecksum): ExactApprovalRequest;
export declare function parseApprovalDecision(value: unknown, request: ExactApprovalRequest, hash: SnapshotChecksum): ExactApprovalDecision;
