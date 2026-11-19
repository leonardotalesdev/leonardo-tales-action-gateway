import { type ExactActionBinding, type ExactApprovalRequest, type ExactApprovalDecision } from './gateway-contract.js';
import type { ActionProposal } from './action-contract.js';
export declare function approvalRequestId(binding: ExactActionBinding): string;
export declare function approvalDecisionId(requestId: string): string;
export declare function makeApprovalRequest(binding: ExactActionBinding, proposal: ActionProposal, createdAt: string, expiresAt: string): ExactApprovalRequest;
export declare function parseApprovalRequest(value: unknown, binding: ExactActionBinding, proposal: ActionProposal): ExactApprovalRequest;
export declare function parseApprovalDecision(value: unknown, request: ExactApprovalRequest): ExactApprovalDecision;
