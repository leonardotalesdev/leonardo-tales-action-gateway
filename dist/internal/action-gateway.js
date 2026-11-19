import { lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createTaskRunStore } from './task-run-store.js';
import { createTask, createRun, getRunNextAction, transitionRun } from './task-run.js';
import { validateActionProposal } from './action-contract.js';
import { createTaskAllowance, nativeRunId, operationId, positiveInteger } from './action-allowance.js';
import { createTrustedExecutionGateway } from './execution-gateway.js';
import { approvalDecisionId, approvalRequestId, parseApprovalDecision, parseApprovalRequest } from './gateway-approval.js';
import { ExecutionGatewayError } from './gateway-contract.js';
import { computeSnapshotChecksum as digest } from './digest.js';
import { copyLocalJson, localId, localObject, localTimestamp, openLocalAuditPort, openLocalRecordStore } from './local-store.js';
function runAction(result) {
    if (!result.ok)
        throw new Error(result.error);
    return result.value;
}
/** Trusted local host only. Expose a narrower input-only tool wrapper to an agent. */
export async function createActionGateway(options) {
    const { directory, approverId, review, timeoutMs = 10_000, now = () => new Date().toISOString() } = options;
    const task = copyLocalJson(options.task);
    const { id: action, revision, amount: measure, execute: handler } = options.tool;
    const projectId = `project-action-${digest(task.id)}`;
    const taskId = `task-action-${digest(task.id)}`;
    if (!isAbsolute(directory) || resolve(directory) !== directory || directory === '/'
        || !localId(task.id) || !localId(task.unit) || !positiveInteger(task.cap) || !localTimestamp(task.expiresAt)
        || !localId(approverId) || !localId(action) || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(action)
        || !positiveInteger(revision) || !positiveInteger(timeoutMs) || timeoutMs > 30_000
        || typeof measure !== 'function' || typeof handler !== 'function' || typeof review !== 'function')
        throw new Error('invalid-action-gateway-config');
    localObject(task, ['id', 'cap', 'unit', 'expiresAt']);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
        throw new Error('unsafe-action-gateway-directory');
    const manifest = { schemaVersion: 'action-allowance/v0.1', task, action, revision, approverId, timeoutMs };
    const state = await openLocalRecordStore(join(directory, 'state'), projectId);
    const audit = await openLocalAuditPort(join(directory, 'audit'), projectId);
    const allowance = createTaskAllowance(projectId, taskId, task.cap, manifest);
    const agentRef = { id: 'action-gateway-host', revision: 1 };
    const agent = {
        id: agentRef.id,
        declarativeProfile: {
            schemaVersion: 'agent-profile/v0.1', revision: 1, executionAvailable: false,
            capabilityIds: ['local-action'], actionIds: [action],
        },
    };
    const definition = {
        id: action, revision, category: 'local-action', description: 'Trusted host registered action', requiredCapability: 'local-action',
        targetKind: 'logical-operation', targetInputField: 'operationKey', riskLevel: 'medium', sideEffect: 'execute',
        auditRequired: true, approvalMayBeRequired: true, executionAvailable: false,
        inputFields: { payload: { type: 'object', required: true }, amount: { type: 'number', required: true },
            unit: { type: 'string', required: true }, operationKey: { type: 'string', required: true } },
    };
    const profile = {
        id: 'action-gateway-local', revision: 1, permissionTier: 2,
        flags: { involvesSecrets: false, involvesProduction: false, involvesExternalIntegration: false, involvesRealUserData: false,
            involvesFinancialOrLegalOrHealthData: false, proposesCommitOrPush: false, proposesDeployment: false, proposesPublicClaim: false },
    };
    async function workflow(port, runId) {
        const store = createTaskRunStore(port, projectId);
        let owner = (await store.loadTask(taskId))?.task;
        if (!owner) {
            owner = runAction(createTask({ id: taskId, projectId, title: 'Guarded action task', description: 'Host-owned action allowance.', createdAt: now() }));
            await store.createTask(owner);
        }
        let run = await store.loadRun(runId);
        if (!run) {
            run = runAction(createRun(owner, { id: runId, agentDefinitionRef: agentRef, createdAt: now(), maxSteps: task.cap }));
            await store.createRun(run);
        }
        if (run.status === 'created') {
            const started = transitionRun(owner, run, { id: `start-${runId}`, type: 'start', projectId, taskId, runId, expectedRevision: run.revision, occurredAt: now() });
            if (started.status !== 'applied')
                throw new Error('run-start-refused');
            await store.saveRun(started.run, run.revision);
            run = started.run;
        }
        return { owner, run };
    }
    function proposal(owner, run, operation, input) {
        return runAction(validateActionProposal({ schemaVersion: 'action-proposal/v0.1', id: operationId(operation.key), revision: 1,
            projectId, taskId, runId: run.id, runRevision: operation.runRevision, agentRef, actionRef: { id: action, revision },
            input: { payload: input, amount: operation.amount, unit: task.unit, operationKey: operation.key },
            target: { kind: 'logical-operation', resource: operation.key } }, { task: owner, run, agent, definitions: [definition], createdAt: operation.createdAt }));
    }
    async function storedApproval(value) {
        const registered = await state.read('proposals', operationId(value.key));
        if (!registered)
            return null;
        const stored = registered.payload;
        if (stored.binding.proposalDigest !== value.proposalDigest || digest(stored.proposal) !== value.proposalDigest)
            throw new Error('approval-binding-conflict');
        const row = await state.read('approval-requests', approvalRequestId(stored.binding));
        if (!row)
            return null;
        const request = parseApprovalRequest(row.payload, stored.binding, stored.proposal);
        const recorded = await state.read('approval-decisions', approvalDecisionId(request.id));
        return { request, decision: recorded ? parseApprovalDecision(recorded.payload, request) : null };
    }
    async function receipt(key, override, replayed = false) {
        const { totals, selected } = await allowance.snapshot(state, key);
        if (!selected)
            throw new Error('missing-task-operation');
        const { value, result } = selected;
        const approval = await storedApproval(value);
        let decision = 'APPROVAL_REQUIRED';
        let reason = 'exact-approval-required';
        if (value.phase === 'blocked') {
            decision = 'BLOCKED';
            reason = value.refusalBasis?.reason ?? 'task_limit';
        }
        else if (result?.status === 'confirmed-success') {
            decision = 'EXECUTED';
            reason = 'confirmed-success';
        }
        else if (result?.status === 'confirmed-failure' && result.effect === 'not-performed') {
            decision = 'BLOCKED';
            reason = 'confirmed-no-effect';
        }
        else if (value.phase === 'held') {
            decision = 'UNKNOWN';
            reason = 'reconciliation-required';
        }
        else if (approval?.decision?.decision === 'DENIED') {
            decision = 'BLOCKED';
            reason = 'approval-denied';
        }
        else if (approval && now() >= approval.request.expiresAt) {
            decision = 'BLOCKED';
            reason = 'expired';
        }
        return Object.freeze({ taskId: task.id, runId: value.runId, operationKey: value.key, action, unit: task.unit,
            requested: value.amount, inputDigest: value.inputDigest, proposalDigest: value.proposalDigest, ...totals,
            refusalBasis: value.refusalBasis ? Object.freeze({ ...value.refusalBasis, requested: value.amount }) : null,
            decision, reason, ...(decision === 'APPROVAL_REQUIRED' || override?.decision === 'CONFLICT' ? override : undefined),
            replayed, approvalRequestId: approval?.request.id ?? null,
            evidenceId: result && result.status !== 'unknown' ? result.evidenceRef.id : null });
    }
    return Object.freeze({
        async inspect(operationKey) {
            if (!localId(operationKey))
                throw new Error('invalid-operation-key');
            const value = await allowance.read(state, operationKey);
            if (!value)
                return null;
            await allowance.verifyManifest(state);
            return receipt(operationKey);
        },
        async execute(intent) {
            const { runId, operationKey, input: supplied } = localObject(intent, ['runId', 'operationKey', 'input']);
            if (!localId(runId) || !localId(operationKey) || !supplied || typeof supplied !== 'object' || Array.isArray(supplied))
                throw new Error('invalid-action-intent');
            const input = copyLocalJson(supplied);
            const inputDigest = digest(input);
            // Task metadata and the logical identity are written with the same project writer as admission.
            const prepared = await state.exclusive(async (port) => {
                await allowance.verifyManifest(port, true);
                const existing = await allowance.read(port, operationKey);
                if (existing && existing.inputDigest !== inputDigest)
                    return { operation: existing, conflict: true };
                const amount = measure(input);
                if (existing && existing.amount !== amount)
                    return { operation: existing, conflict: true };
                if (!positiveInteger(amount))
                    throw new Error('invalid-action-amount');
                if (existing && (existing.phase !== 'pending' || existing.runId !== runId || await port.read('proposals', operationId(operationKey)))) {
                    return { operation: existing };
                }
                const context = await workflow(port, nativeRunId(runId));
                if (getRunNextAction(context.run) !== 'continue' || now() >= task.expiresAt)
                    throw new Error('run-not-ready');
                const initial = existing ?? { key: operationKey, runId, amount, createdAt: now(), runRevision: context.run.revision,
                    inputDigest, phase: 'pending', binding: null };
                const actionProposal = proposal(context.owner, context.run, initial, input);
                const operation = { ...initial, proposalDigest: digest(actionProposal) };
                if (existing && existing.proposalDigest !== operation.proposalDigest)
                    throw new Error('operation-proposal-conflict');
                if (!existing)
                    await allowance.register(port, operation);
                return { operation, actionProposal };
            });
            const value = prepared.operation;
            if (prepared.conflict)
                return receipt(operationKey, { decision: 'CONFLICT', reason: 'operation-conflict' });
            if (value.phase !== 'pending')
                return receipt(operationKey, undefined, true);
            const prior = await storedApproval(value);
            if (prior?.decision?.decision === 'DENIED')
                return receipt(operationKey, undefined, true);
            if (value.runId !== runId)
                return receipt(operationKey, { decision: 'BLOCKED', reason: 'operation-bound-to-original-run' });
            let endorsed;
            const matches = (request) => endorsed?.digest === digest(request);
            const gateway = createTrustedExecutionGateway({
                scope: { id: `scope-${digest(manifest)}`, revision: 1, projectId, taskId, runId: nativeRunId(runId), agentRef, expiresAt: task.expiresAt },
                state, audit, agent, approverIds: [approverId], approvalLifetimeMs: 300_000, adapterTimeoutMs: timeoutMs,
                host: {
                    actorId: agentRef.id, now, scopeIsCurrent: () => true,
                    actionIsInScope: (item) => item.id === operationId(value.key) && digest(item) === value.proposalDigest,
                    captureDecision: async (request) => {
                        if (!endorsed || !matches(request))
                            throw new ExecutionGatewayError('invalid-approval');
                        return { approverId, decision: endorsed.decision };
                    },
                    verifyStoredDecision: (decision, request) => matches(request) && decision.approverId === approverId && decision.decision === endorsed?.decision,
                },
                admit: (port, binding) => allowance.reserve(port, value.key, binding),
                actions: [{ definition, profile, adapter: {
                            id: 'action-gateway-local-handler', revision,
                            invoke: async (context) => {
                                if (context.signal.aborted || !context.isAuthorized(context.authority, context.executionIdentity, context.proposalDigest))
                                    return { status: 'unknown' };
                                const result = await handler(context.proposal.input.payload, context.signal);
                                if (!result || result.outcome === 'unknown' || !localId(result.evidenceId))
                                    return { status: 'unknown' };
                                const evidenceRef = { id: result.evidenceId, revision: 1 };
                                if (result.outcome === 'executed')
                                    return { status: 'confirmed-success', evidenceRef };
                                if (result.outcome === 'no-effect')
                                    return { status: 'confirmed-failure', effect: 'not-performed', evidenceRef };
                                return { status: 'unknown' };
                            },
                        } }],
            });
            const id = operationId(value.key);
            try {
                if (prepared.actionProposal)
                    await gateway.registerProposal(prepared.actionProposal);
                const request = await gateway.requestApproval(id);
                const requestDigest = digest(request);
                const decision = await review(Object.freeze({ taskId: task.id, runId, operationKey, action,
                    input: request.proposal.input.payload, amount: value.amount, unit: task.unit,
                    cap: task.cap, requestId: request.id, requestDigest, expiresAt: request.expiresAt }));
                if (decision === 'PENDING')
                    return receipt(operationKey);
                if (decision !== 'APPROVED' && decision !== 'DENIED')
                    throw new ExecutionGatewayError('invalid-approval');
                if (prior?.decision && prior.decision.decision !== decision)
                    throw new ExecutionGatewayError('invalid-approval');
                endorsed = { digest: requestDigest, decision };
                if (!prior?.decision)
                    await gateway.captureApproval(request.id);
                if (decision === 'DENIED')
                    return receipt(operationKey);
                const result = await gateway.execute(id);
                const latest = (await allowance.read(state, operationKey));
                if (latest.phase === 'pending') {
                    return receipt(operationKey, { decision: result.status === 'execution_unknown' ? 'UNKNOWN' : 'BLOCKED', reason: result.code });
                }
                return receipt(operationKey);
            }
            catch (error) {
                const latest = (await allowance.read(state, operationKey));
                if (latest.phase !== 'pending')
                    return receipt(operationKey, undefined, true);
                return receipt(operationKey, { decision: 'BLOCKED', reason: error instanceof ExecutionGatewayError ? error.code : 'storage-or-review-failure' });
            }
        },
    });
}
