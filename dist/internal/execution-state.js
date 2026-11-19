import { computeSnapshotChecksum } from './digest.js';
import { localId, localObject, localRevision, localTimestamp, LocalStoreError } from './local-store.js';
function binding(value) {
    const raw = localObject(value, ['projectId', 'taskId', 'runId', 'proposalRef', 'proposalDigest']);
    const ref = localObject(raw.proposalRef, ['id', 'revision']);
    if (!localId(raw.projectId) || !raw.projectId.startsWith('project-')
        || !localId(raw.taskId) || !raw.taskId.startsWith('task-') || !localId(raw.runId) || !raw.runId.startsWith('run-')
        || !localId(ref.id) || !localRevision(ref.revision)
        || typeof raw.proposalDigest !== 'string' || !/^[a-f0-9]{64}$/.test(raw.proposalDigest))
        throw new LocalStoreError('invalid-record');
    return Object.freeze({ projectId: raw.projectId, taskId: raw.taskId, runId: raw.runId,
        proposalRef: Object.freeze({ id: ref.id, revision: ref.revision }), proposalDigest: raw.proposalDigest });
}
function identities(value) {
    const { proposalDigest, ...reference } = value;
    return { id: `execution-${computeSnapshotChecksum(reference)}`,
        executionIdentity: `action-${computeSnapshotChecksum({ ...reference, proposalDigest })}` };
}
/** Deterministic metadata only; it neither reserves nor authorizes an attempt. */
export function executionStateIdentity(value) {
    return Object.freeze(identities(binding(value)));
}
export function validateExecutionState(value) {
    const raw = localObject(value, ['schemaVersion', 'id', 'executionIdentity', 'revision', 'status',
        'createdAt', 'updatedAt', 'projectId', 'taskId', 'runId', 'proposalRef', 'proposalDigest']);
    const scope = binding({ projectId: raw.projectId, taskId: raw.taskId, runId: raw.runId,
        proposalRef: raw.proposalRef, proposalDigest: raw.proposalDigest });
    const identity = identities(scope);
    if (raw.schemaVersion !== 'execution-state/v0.1' || raw.id !== identity.id || raw.executionIdentity !== identity.executionIdentity
        || !localRevision(raw.revision) || !localTimestamp(raw.createdAt) || !localTimestamp(raw.updatedAt)
        || raw.updatedAt < raw.createdAt || !['proposed', 'execution_started', 'execution_unknown',
        'reconciliation_required', 'executed', 'failed'].includes(raw.status))
        throw new LocalStoreError('invalid-record');
    const revisions = {
        proposed: [1], execution_started: [2], execution_unknown: [3], reconciliation_required: [4], executed: [3], failed: [2, 3],
    };
    if (!revisions[raw.status].includes(raw.revision)
        || (raw.status === 'proposed' && raw.createdAt !== raw.updatedAt))
        throw new LocalStoreError('invalid-record');
    return Object.freeze({ ...scope, ...identity, schemaVersion: 'execution-state/v0.1', revision: raw.revision,
        status: raw.status, createdAt: raw.createdAt, updatedAt: raw.updatedAt });
}
export function createExecutionStateStore(port, projectId) {
    async function load(id) {
        const record = await port.read('execution', id);
        if (!record)
            return null;
        const state = validateExecutionState(record.payload);
        if (record.id !== state.id || record.projectId !== projectId || state.projectId !== projectId
            || record.revision !== state.revision)
            throw new LocalStoreError('corrupt-record');
        const run = await port.read('runs', state.runId);
        const parent = run?.payload;
        if (!run || run.projectId !== projectId || parent?.schemaVersion !== 'run/v0.1' || parent.id !== state.runId
            || parent.projectId !== projectId || parent.taskId !== state.taskId
            || !localTimestamp(parent.createdAt) || state.createdAt < parent.createdAt) {
            throw new LocalStoreError('corrupt-record');
        }
        return state;
    }
    return Object.freeze({ load,
        async create(value, createdAt) {
            const scope = binding(value);
            if (scope.projectId !== projectId || !localTimestamp(createdAt))
                throw new LocalStoreError('invalid-record');
            const run = await port.read('runs', scope.runId);
            const parent = run?.payload;
            if (!run || run.projectId !== projectId || parent?.schemaVersion !== 'run/v0.1' || parent.id !== scope.runId
                || parent.projectId !== projectId || parent.taskId !== scope.taskId
                || !localTimestamp(parent.createdAt) || createdAt < parent.createdAt) {
                throw new LocalStoreError('invalid-record');
            }
            const state = Object.freeze({ ...scope, ...identities(scope), schemaVersion: 'execution-state/v0.1',
                revision: 1, status: 'proposed', createdAt, updatedAt: createdAt });
            await port.create({ kind: 'execution', id: state.id, projectId, revision: 1, payload: state });
            return state;
        },
        /** Persist host observations only. M3 neither authorizes nor dispatches the described action. */
        async recordObservation(id, expectedRevision, status, occurredAt) {
            const previous = await load(id);
            if (!previous || previous.revision !== expectedRevision)
                throw new LocalStoreError('stale-revision');
            const transitions = {
                proposed: ['execution_started', 'failed'], execution_started: ['execution_unknown', 'executed', 'failed'],
                execution_unknown: ['reconciliation_required'], reconciliation_required: [], executed: [], failed: [],
            };
            if (!transitions[previous.status].includes(status) || !localTimestamp(occurredAt)
                || occurredAt < previous.updatedAt || !localRevision(expectedRevision + 1))
                throw new LocalStoreError('invalid-record');
            const state = validateExecutionState({ ...previous, status, revision: expectedRevision + 1, updatedAt: occurredAt });
            await port.save({ kind: 'execution', id, projectId, revision: state.revision, payload: state }, expectedRevision);
            return state;
        },
    });
}
