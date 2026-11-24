import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { validateExplicitLegacyLocale } from './digest.js';
import { ExecutionAuditError } from './execution-audit.js';
import { canonicalGatewayPath, localId, localObject, localRevision, localTimestamp, LocalStoreError, openReconciliationStore } from './local-store.js';
import { createReconciliationDecisionKernel, ReconciliationDecisionError } from './reconciliation-decision.js';
import { taskStoreIdentity } from './store-manifest.js';
class HostRefusal extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
function refuse(code) { throw new HostRefusal(code); }
function config(value) {
    try {
        const keys = ['directory', 'taskId', 'host'];
        if (!types.isProxy(value) && value && typeof value === 'object' && Object.hasOwn(value, 'legacyDigestLocale')) {
            keys.push('legacyDigestLocale');
        }
        const { directory, taskId, legacyDigestLocale, host } = localObject(value, keys);
        const { actorId, now, resolveEvidence } = localObject(host, ['actorId', 'now', 'resolveEvidence']);
        if (typeof directory !== 'string' || !localId(taskId) || !localId(actorId)
            || typeof now !== 'function' || types.isProxy(now) || types.isAsyncFunction(now)
            || typeof resolveEvidence !== 'function' || types.isProxy(resolveEvidence))
            refuse('invalid-host-config');
        if (legacyDigestLocale !== undefined) {
            if (typeof legacyDigestLocale !== 'string')
                refuse('invalid-host-config');
            validateExplicitLegacyLocale(legacyDigestLocale);
        }
        return { directory, taskId, legacyDigestLocale, host: {
                actorId, now: now,
                resolveEvidence: resolveEvidence,
            } };
    }
    catch {
        refuse('invalid-host-config');
    }
}
function evidenceRef(value) {
    const { id, revision } = localObject(value, ['id', 'revision']);
    if (!localId(id) || !localRevision(revision))
        throw new LocalStoreError('invalid-record');
    return Object.freeze({ id, revision });
}
function request(value) {
    try {
        const raw = localObject(value, ['requestId', 'operationKey', 'evidenceRef']);
        if (!localId(raw.requestId) || !localId(raw.operationKey))
            refuse('invalid-request');
        return Object.freeze({ requestId: raw.requestId, operationKey: raw.operationKey, evidenceRef: evidenceRef(raw.evidenceRef) });
    }
    catch {
        refuse('invalid-request');
    }
}
function isDigest(value) {
    return typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
}
function assessment(value) {
    try {
        if (!value || typeof value !== 'object' || types.isProxy(value))
            refuse('invalid-assessment');
        const status = Object.getOwnPropertyDescriptor(value, 'status')?.value;
        if (status === 'unresolved') {
            localObject(value, ['status']);
            return Object.freeze({ status });
        }
        if (status !== 'confirmed-effect' && status !== 'confirmed-no-effect')
            refuse('invalid-assessment');
        const keys = ['status', 'binding', 'evidenceDigest', 'qualifiedAt'];
        const raw = localObject(value, status === 'confirmed-effect' ? [...keys, 'effectOccurredDigest']
            : [...keys, 'effectAbsentDigest', 'attemptFinalityDigest']);
        const bound = localObject(raw.binding, ['requestId', 'actorId', 'evidenceRef', 'subjectDigest', 'expectedState']);
        const { requestId, actorId, subjectDigest, expectedState } = bound;
        if (!localId(requestId) || !localId(actorId) || !isDigest(subjectDigest) || !isDigest(expectedState)
            || !isDigest(raw.evidenceDigest))
            refuse('invalid-assessment');
        const binding = Object.freeze({ requestId, actorId, evidenceRef: evidenceRef(bound.evidenceRef), subjectDigest, expectedState });
        if (!localTimestamp(raw.qualifiedAt))
            refuse('invalid-clock');
        const basis = { binding, evidenceDigest: raw.evidenceDigest, qualifiedAt: raw.qualifiedAt };
        if (status === 'confirmed-effect') {
            if (!isDigest(raw.effectOccurredDigest))
                refuse('invalid-assessment');
            return Object.freeze({ status, ...basis, effectOccurredDigest: raw.effectOccurredDigest });
        }
        if (!isDigest(raw.effectAbsentDigest) || !isDigest(raw.attemptFinalityDigest))
            refuse('invalid-assessment');
        return Object.freeze({ status, ...basis, effectAbsentDigest: raw.effectAbsentDigest, attemptFinalityDigest: raw.attemptFinalityDigest });
    }
    catch (error) {
        if (error instanceof HostRefusal)
            throw error;
        refuse('invalid-assessment');
    }
}
const resolverDeadlineMs = 30_000;
const nativeThen = Promise.prototype.then;
function resolveAssessment(resolveEvidence, context) {
    return new Promise((resolve, reject) => {
        const abort = new AbortController();
        const deadline = performance.now() + resolverDeadlineMs;
        let pending = true;
        const timer = setTimeout(expire, resolverDeadlineMs);
        function finish() {
            if (!pending)
                return false;
            pending = false;
            clearTimeout(timer);
            return true;
        }
        function expire() {
            if (!finish())
                return;
            reject(new HostRefusal('resolver-timeout'));
            abort.abort();
        }
        function failed() {
            if (performance.now() >= deadline)
                expire();
            else if (finish())
                reject(new HostRefusal('resolver-failed'));
        }
        let result;
        try {
            result = resolveEvidence(context, abort.signal);
        }
        catch {
            failed();
            return;
        }
        // The native then would consult the constructor for its species. Require an
        // ordinary Promise and exclude own overrides before installing either reaction.
        if (types.isProxy(result) || !types.isPromise(result) || Object.getPrototypeOf(result) !== Promise.prototype
            || Object.hasOwn(result, 'constructor') || Object.hasOwn(result, 'then')) {
            if (performance.now() >= deadline)
                expire();
            else if (finish())
                reject(new HostRefusal('invalid-assessment'));
            return;
        }
        nativeThen.call(result, (value) => {
            if (performance.now() >= deadline)
                expire();
            if (!pending)
                return;
            try {
                const normalized = assessment(value);
                if (performance.now() >= deadline)
                    expire();
                if (finish())
                    resolve(normalized);
            }
            catch (error) {
                if (finish())
                    reject(error);
            }
        }, failed);
    });
}
function resolverContext(input, actorId, storeGeneration, observed) {
    const { subject, subjectDigest, expectedState } = observed;
    const { binding, projectId, taskId, originalTaskId, originalRunId, operationKey, amount, unit, digestVersion, inputDigest, proposalDigest, approvalRequestId, approvalRequestDigest, approvalDecisionId, attemptId } = subject;
    return Object.freeze({ requestId: input.requestId, actorId, evidenceRef: input.evidenceRef, subject: Object.freeze({
            projectId, taskId, originalTaskId, runId: binding.runId, originalRunId, operationKey,
            actionRef: Object.freeze({ id: binding.actionRef.id, revision: binding.actionRef.revision }),
            target: Object.freeze({ kind: 'logical-operation', resource: subject.target.resource }),
            amount, unit, digestVersion, inputDigest, proposalDigest, approvalRequestId, approvalRequestDigest, approvalDecisionId,
            attemptId, executionIdentity: binding.executionIdentity, subjectDigest, expectedState, storeGeneration,
            observedPrefix: 'reconciliation-required',
        }) });
}
function qualification(context, resolved) {
    const { requestId, actorId, evidenceRef, subject } = context;
    const { binding, evidenceDigest, qualifiedAt, status: outcome } = resolved;
    const { projectId, taskId, operationKey, attemptId, executionIdentity, storeGeneration, subjectDigest, expectedState } = subject;
    if (binding.requestId !== requestId || binding.actorId !== actorId || binding.evidenceRef.id !== evidenceRef.id
        || binding.evidenceRef.revision !== evidenceRef.revision || binding.subjectDigest !== subjectDigest
        || binding.expectedState !== expectedState)
        refuse('evidence-mismatch');
    const basis = { requestId, actorId, evidenceRef, projectId, taskId, operationKey, attemptId, executionIdentity,
        storeGeneration, subjectDigest, expectedState, evidenceDigest, qualifiedAt };
    return outcome === 'confirmed-effect'
        ? { ...basis, outcome, proof: { effectOccurredDigest: resolved.effectOccurredDigest } }
        : { ...basis, outcome, proof: { effectAbsentDigest: resolved.effectAbsentDigest, attemptFinalityDigest: resolved.attemptFinalityDigest } };
}
function finalReceipt(status, record) {
    const { requestId, operationKey, evidenceRef: ref, outcome } = record.payload.qualification;
    return Object.freeze({ status, requestId, operationKey, evidenceRef: Object.freeze({ id: ref.id, revision: ref.revision }),
        outcome: outcome === 'confirmed-effect' ? 'reconciled-effect' : 'reconciled-no-effect' });
}
function refusalCode(error, stage) {
    if (error instanceof HostRefusal)
        return error.code;
    if (error instanceof ReconciliationDecisionError) {
        switch (error.code) {
            case 'binding-mismatch': return 'stale-state';
            case 'corrupt-record': return 'corrupt-storage';
            case 'invalid-qualification': return 'internal-failure';
            default: return error.code;
        }
    }
    if (error instanceof LocalStoreError) {
        switch (error.code) {
            case 'legacy-digest-locale-required': return 'legacy-locale-required';
            case 'locked': return 'store-busy';
            case 'unsafe-path': return 'unsafe-store';
            case 'write-uncertain': return 'write-uncertain';
            case 'corrupt-record': return 'corrupt-storage';
            case 'stale-revision': return 'stale-state';
            case 'invalid-record': return stage === 'applying' ? 'storage-failure' : 'corrupt-storage';
            case 'already-exists':
            case 'io-error': return 'storage-failure';
            case 'invalid-id': return 'internal-failure';
        }
    }
    if (error instanceof ExecutionAuditError)
        return error.code === 'invalid-event' ? 'internal-failure' : 'corrupt-storage';
    if (error instanceof Error && typeof error.errno === 'number') {
        const { code } = error;
        if (code === 'ENOENT')
            return stage === 'opening' ? 'store-not-found' : 'corrupt-storage';
        if (code === 'ENOTDIR' || code === 'ELOOP' || code === 'ENAMETOOLONG')
            return 'unsafe-store';
        return 'storage-failure';
    }
    return 'internal-failure';
}
/** Trusted local host only. Keep the controller outside model-facing tool registries. */
export async function createTrustedReconciliationHost(options) {
    const { directory, taskId, legacyDigestLocale, host: { actorId, now, resolveEvidence } } = config(options);
    if (!canonicalGatewayPath(directory) || directory.includes('\0'))
        refuse('unsafe-store');
    const { projectId } = taskStoreIdentity(taskId);
    let kernel;
    let storeGeneration;
    let opening = true;
    try {
        const store = await openReconciliationStore(directory, projectId, { legacyDigestLocale });
        opening = false;
        kernel = createReconciliationDecisionKernel({ store, now });
        storeGeneration = await kernel.validateStore(taskId);
    }
    catch (error) {
        refuse(refusalCode(error, opening ? 'opening' : 'observing'));
    }
    return Object.freeze({
        async reconcile(value) {
            let applying = false;
            try {
                const input = request(value);
                const observed = await kernel.observe({ ...input, actorId, storeGeneration });
                if (observed.status === 'replayed')
                    return finalReceipt('replayed', observed.record);
                const context = resolverContext(input, actorId, storeGeneration, observed.result);
                const resolved = await resolveAssessment(resolveEvidence, context);
                if (resolved.status === 'unresolved')
                    return Object.freeze({ status: 'unresolved', ...input });
                const q = qualification(context, resolved);
                applying = true;
                const handle = kernel.issuer.issue(q);
                const { status, record } = await kernel.adjudicator.applyWithDisposition(handle);
                return finalReceipt(status, record);
            }
            catch (error) {
                return Object.freeze({ status: 'refused', code: refusalCode(error, applying ? 'applying' : 'observing') });
            }
        },
    });
}
