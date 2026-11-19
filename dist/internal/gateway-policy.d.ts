import { type PolicyEvaluationInput, type PolicyEvaluationResult } from './base-policy.js';
import type { ActionProposal } from './action-contract.js';
import { type ActionPolicyProfile } from './gateway-contract.js';
export declare function policyInput(proposal: ActionProposal, profile: ActionPolicyProfile, humanApprovalPresent: boolean): PolicyEvaluationInput;
/** Calls the existing evaluator, not another policy implementation. No supplied verdict is accepted. */
export declare function assessPolicy(proposal: ActionProposal, profile: ActionPolicyProfile, humanApprovalPresent: boolean): PolicyEvaluationResult;
