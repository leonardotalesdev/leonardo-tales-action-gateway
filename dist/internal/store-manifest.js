import { computeSnapshotChecksum as digest, currentDigestVersion, legacyDigestVersion } from './digest.js';
import { actionAllowanceKind, localId, localObject, localRevision, localTimestamp, taskManifestId, verifyRecordEnvelope, } from './local-store.js';
export function taskStoreIdentity(id) {
    const hash = digest(id);
    return { projectId: `project-action-${hash}`, taskId: `task-action-${hash}` };
}
function historicalConfiguration(value, projectId) {
    const raw = localObject(value, ['schemaVersion', 'task', 'action', 'revision', 'approverId', 'timeoutMs']);
    const task = localObject(raw.task, ['id', 'cap', 'unit', 'expiresAt']);
    if (raw.schemaVersion !== 'action-allowance/v0.1' || !localId(task.id) || !localRevision(task.cap)
        || !localId(task.unit) || !localTimestamp(task.expiresAt) || taskStoreIdentity(task.id).projectId !== projectId
        || !localId(raw.action) || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(raw.action)
        || !localRevision(raw.revision) || !localId(raw.approverId)
        || !localRevision(raw.timeoutMs) || raw.timeoutMs > 30_000)
        throw new Error('invalid-store-manifest');
    return Object.freeze({ ...raw, task: Object.freeze(task) });
}
export function projectManifest(record, projectId, checksumFor) {
    if (record.kind !== actionAllowanceKind || record.id !== taskManifestId || record.projectId !== projectId) {
        throw new Error('invalid-store-manifest');
    }
    if (record.revision === 1) {
        if (record.digestVersion !== legacyDigestVersion && record.digestVersion !== currentDigestVersion) {
            throw new Error('invalid-store-manifest');
        }
        return { configuration: historicalConfiguration(record.payload, projectId), storeGeneration: null };
    }
    if (record.revision !== 2 || record.digestVersion !== currentDigestVersion)
        throw new Error('invalid-store-manifest');
    const { schemaVersion, storeGeneration, sourceManifest } = localObject(record.payload, ['schemaVersion', 'storeGeneration', 'sourceManifest']);
    if (schemaVersion !== 'action-allowance/v0.2' || typeof storeGeneration !== 'string'
        || !/^[a-f0-9]{64}$/.test(storeGeneration) || /^0+$/.test(storeGeneration))
        throw new Error('invalid-store-manifest');
    const source = verifyRecordEnvelope(sourceManifest, projectId, actionAllowanceKind, checksumFor, taskManifestId).record;
    if (source.revision !== 1)
        throw new Error('invalid-store-manifest');
    if (source.digestVersion === legacyDigestVersion)
        checksumFor(legacyDigestVersion);
    return { configuration: historicalConfiguration(source.payload, projectId), storeGeneration };
}
