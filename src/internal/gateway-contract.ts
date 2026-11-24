import type { ActionDefinition, ActionProposal, ActionProposalContext } from './action-contract.js'
import type { RunReference } from './task-run.js'
import type { PolicyEvaluationInput } from './base-policy.js'
import type { LocalLockedRecordPort, LocalTransactionalRecordPort } from './local-store.js'
import type { ExecutionAuditPort } from './execution-audit.js'
import type { DigestVersion } from './digest.js'

export type GatewayScope = Readonly<{
  id: string; revision: number; projectId: string; taskId: string; runId: string
  agentRef: RunReference; expiresAt: string
}>
export type ActionPolicyProfile = Readonly<{
  id: string; revision: number; permissionTier: PolicyEvaluationInput['permissionTier']
  flags: Readonly<Pick<PolicyEvaluationInput, 'involvesSecrets' | 'involvesProduction' | 'involvesExternalIntegration'
    | 'involvesRealUserData' | 'involvesFinancialOrLegalOrHealthData' | 'proposesCommitOrPush'
    | 'proposesDeployment' | 'proposesPublicClaim'>>
}>
export type ExactActionBinding = Readonly<{
  projectId: string; taskId: string; runId: string; taskRevision: number; baseRunRevision: number
  agentRef: RunReference; proposalRef: RunReference; actionRef: RunReference
  proposalDigest: string; definitionDigest: string; policyProfileRef: RunReference; policyInputDigest: string
  adapterRef: RunReference; scopeDigest: string; executionId: string; executionIdentity: string
}>
export type ExactApprovalRequest = Readonly<{
  schemaVersion: 'exact-approval-request/v0.1'; id: string; binding: ExactActionBinding
  proposal: ActionProposal; createdAt: string; expiresAt: string
}>
export type ExactApprovalDecision = Readonly<{
  schemaVersion: 'exact-approval-decision/v0.1'; id: string; requestId: string; requestDigest: string
  bindingDigest: string; approverId: string; decision: 'APPROVED' | 'DENIED'; decidedAt: string
}>
declare const authorityBrand: unique symbol
/** Object-identity checked at runtime; equivalent JSON is never a permit. */
export type ExecutionAuthority = Readonly<{
  kind: 'execution-authority'; executionIdentity: string; proposalDigest: string
  [authorityBrand]: true
}>
export type AuthorizedExecutionContext = Readonly<{
  proposal: ActionProposal; executionIdentity: string; proposalDigest: string
  authority: ExecutionAuthority; signal: AbortSignal
  isAuthorized(authority: unknown, identity: string, digest: string): boolean
}>
export type ExecutionAdapterResult =
  | Readonly<{ status: 'confirmed-success'; evidenceRef: RunReference }>
  | Readonly<{ status: 'confirmed-failure'; effect: 'not-performed' | 'terminal-no-retry'; evidenceRef: RunReference }>
  | Readonly<{ status: 'unknown' }>
export type TrustedExecutionAdapter = Readonly<{
  id: string; revision: number
  invoke(context: AuthorizedExecutionContext): Promise<ExecutionAdapterResult>
}>
export type GatewayAction = Readonly<{ definition: ActionDefinition; profile: ActionPolicyProfile; adapter: TrustedExecutionAdapter }>
export type TrustedGatewayHost = Readonly<{
  actorId: string
  now(): string
  /** Current native scope/revocation fact, not a model-authored permission decision. */
  scopeIsCurrent(scope: GatewayScope): boolean
  /** Native target/data-scope fact. Structural proposal validity alone does not establish it. */
  actionIsInScope(proposal: ActionProposal): boolean
  /** The host supplies the verified human identity. This library implements no authentication. */
  captureDecision?(request: ExactApprovalRequest): Promise<Readonly<{ approverId: string; decision: 'APPROVED' | 'DENIED' }>>
  /** Required to trust stored approval after restart; defaults to same-process captured evidence only. */
  verifyStoredDecision?(decision: ExactApprovalDecision, request: ExactApprovalRequest): boolean
}>
export type ExecutionGatewayOptions = Readonly<{
  digestVersion: DigestVersion
  scope: GatewayScope; agent: ActionProposalContext['agent']; actions: readonly GatewayAction[]
  state: LocalTransactionalRecordPort; audit: ExecutionAuditPort; host: TrustedGatewayHost
  approverIds: readonly string[]; approvalLifetimeMs: number; adapterTimeoutMs: number
  /** Trusted admission under the project writer, after policy/approval and before any dispatch reservation. */
  admit?(port: LocalLockedRecordPort, binding: ExactActionBinding): Promise<boolean>
}>
export type GatewayErrorCode = 'invalid-record' | 'invalid-proposal' | 'invalid-policy' | 'blocked-policy'
  | 'approval-required' | 'approval-denied' | 'invalid-approval' | 'expired' | 'stale-context'
  | 'scope-denied' | 'run-not-ready' | 'replay' | 'reconciliation-required' | 'storage-failure' | 'task-limit'
export class ExecutionGatewayError extends Error {
  readonly code: GatewayErrorCode
  constructor(code: GatewayErrorCode) { super(code); this.code = code }
}
export type GatewayResult = Readonly<{
  status: 'executed' | 'failed' | 'execution_unknown' | 'refused'
  code: string; executionId?: string
}>
