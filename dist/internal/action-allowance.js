import { computeSnapshotChecksum as digest } from './digest.js';
import { projectManifest } from './store-manifest.js';
import { readClosedExecution } from './execution-gateway.js';
import { isReconciliationRecordId } from './reconciliation-record.js';
import { actionAllowanceKind as kind, localId, localObject, localRevision, localTimestamp, taskManifestId as manifestId } from './local-store.js';
export function operationId(key) { return `operation-${digest(key)}`; }
export function nativeRunId(id) { return `run-${digest(id)}`; }
export function positiveInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
export function createTaskAllowance(projectId, taskId, cap, manifest) {
    async function verifyManifest(port, mode = 'existing') {
        const record = await port.read(kind, manifestId);
        if (!record) {
            if (mode === 'existing' || (await port.list(kind)).length)
                throw new Error('missing-task-allowance');
            if (mode === 'initialize') {
                if (!port.create)
                    throw new Error('missing-task-allowance');
                await port.create({ kind, projectId, id: manifestId, revision: 1, payload: manifest });
            }
            return;
        }
        const { configuration } = projectManifest(record, projectId, port.checksumFor);
        if (digest(configuration) !== digest(manifest))
            throw new Error('task-configuration-conflict');
    }
    function parse(record) {
        const fields = ['key', 'runId', 'runRevision', 'createdAt', 'inputDigest', 'proposalDigest', 'amount', 'phase', 'binding'];
        // Earlier blocked operations did not record a decision-time balance.
        if (record.payload && typeof record.payload === 'object' && Object.hasOwn(record.payload, 'refusalBasis'))
            fields.push('refusalBasis');
        const raw = localObject(record.payload, fields);
        const value = { ...raw, digestVersion: record.digestVersion };
        const binding = value.binding;
        if (!localId(value.key) || record.id !== operationId(value.key) || !localId(value.runId)
            || !localRevision(value.runRevision) || !localTimestamp(value.createdAt) || !positiveInteger(value.amount)
            || ![value.inputDigest, value.proposalDigest].every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
            || (value.phase === 'pending' ? record.revision !== 1 || binding !== null
                : !['held', 'blocked'].includes(value.phase) || record.revision !== 2 || !binding
                    || binding.projectId !== projectId || binding.taskId !== taskId || binding.runId !== nativeRunId(value.runId)
                    || binding.baseRunRevision !== value.runRevision || binding.proposalRef?.id !== record.id
                    || binding.proposalDigest !== value.proposalDigest))
            throw new Error('invalid-task-operation');
        if (value.refusalBasis !== undefined) {
            const basis = value.refusalBasis;
            localObject(basis, ['reason', 'cap', 'settled', 'held', 'remaining']);
            if (value.phase !== 'blocked' || basis.reason !== 'task_limit' || basis.cap !== cap
                || ![basis.settled, basis.held, basis.remaining].every((n) => Number.isSafeInteger(n) && n >= 0)
                || basis.remaining !== cap - basis.settled - basis.held || value.amount <= basis.remaining)
                throw new Error('invalid-refusal-basis');
        }
        return value;
    }
    async function read(port, key) {
        const row = await port.read(kind, operationId(key));
        if (!row)
            return null;
        const value = parse(row);
        if (value.key !== key)
            throw new Error('invalid-task-operation');
        return value;
    }
    function register(port, { digestVersion, ...value }) {
        return port.create({ kind, projectId, id: operationId(value.key), revision: 1, payload: value, digestVersion });
    }
    async function outcome(port, value, decision) {
        if (value.phase !== 'held') {
            if (decision)
                throw new Error('invalid-reconciliation-history');
            return null;
        }
        const native = await readClosedExecution(port, value.binding, value.digestVersion);
        if (!decision)
            return native;
        if (native)
            throw new Error('invalid-reconciliation-history');
        if (decision.payload.phase === 'qualified')
            return null;
        const { outcome: resolved, evidenceRef } = decision.payload.qualification;
        return {
            status: resolved === 'confirmed-effect' ? 'reconciled-effect' : 'reconciled-no-effect',
            evidenceRef,
        };
    }
    async function snapshot(port, key, decisions, rows) {
        let remaining = cap;
        let settled = 0;
        let held = 0;
        let selected;
        const validatedDecisions = new Set(Array.from(decisions?.values() ?? [], (decision) => decision.id));
        for (const row of rows ?? await port.list(kind)) {
            if (row.id === manifestId)
                continue;
            if (isReconciliationRecordId(row.id)) {
                if (!validatedDecisions.delete(row.id))
                    throw new Error('invalid-reconciliation-history');
                continue;
            }
            const value = parse(row);
            const result = await outcome(port, value, decisions?.get(value.key));
            if (value.key === key)
                selected = { value, result };
            if (value.phase !== 'held')
                continue;
            if (result?.status === 'reconciled-no-effect'
                || (result?.status === 'confirmed-failure' && result.effect === 'not-performed'))
                continue;
            if (value.amount > remaining)
                throw new Error('task-allowance-inconsistent');
            remaining -= value.amount;
            if (result?.status === 'confirmed-success' || result?.status === 'reconciled-effect')
                settled += value.amount;
            else
                held += value.amount;
        }
        if (validatedDecisions.size)
            throw new Error('invalid-reconciliation-history');
        return { totals: { cap, settled, held, remaining }, selected };
    }
    async function reserve(port, key, binding, version, view) {
        await verifyManifest(port);
        const value = await read(port, key);
        if (!value || value.digestVersion !== version || value.proposalDigest !== binding.proposalDigest
            || operationId(key) !== binding.proposalRef.id
            || binding.runId !== nativeRunId(value.runId) || binding.projectId !== projectId || binding.taskId !== taskId) {
            throw new Error('reservation-binding-conflict');
        }
        // A prior hold can exist even if the gateway crashed before creating its attempt record.
        if (value.phase !== 'pending')
            return false;
        const { totals } = await snapshot(view?.port ?? port, undefined, view?.decisions, view?.rows);
        const admitted = value.amount <= totals.remaining;
        const decision = admitted ? { phase: 'held' } : { phase: 'blocked', refusalBasis: { reason: 'task_limit', ...totals } };
        const { digestVersion, ...payload } = value;
        await port.save({ kind, projectId, id: operationId(key), revision: 2, digestVersion,
            payload: { ...payload, binding, ...decision } }, 1);
        return admitted;
    }
    return { verifyManifest, read, register, snapshot, reserve, parseOperation: parse };
}
