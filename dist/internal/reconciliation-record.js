import { computeSnapshotChecksum as digest, currentDigestVersion } from './digest.js';
import { actionAllowanceKind, copyLocalJson, localId, localObject, localRevision, localTimestamp, LocalStoreError } from './local-store.js';
function hex(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
export function normalizeQualification(value) {
    const copy = copyLocalJson(value);
    const q = localObject(copy, ['requestId', 'actorId', 'projectId', 'taskId', 'operationKey', 'attemptId',
        'executionIdentity', 'storeGeneration', 'subjectDigest', 'expectedState', 'outcome', 'evidenceRef',
        'evidenceDigest', 'proof', 'qualifiedAt']);
    const evidence = localObject(q.evidenceRef, ['id', 'revision']);
    const proofFields = q.outcome === 'confirmed-effect' ? ['effectOccurredDigest'] : ['effectAbsentDigest', 'attemptFinalityDigest'];
    const proof = localObject(q.proof, proofFields);
    if (!['confirmed-effect', 'confirmed-no-effect'].includes(q.outcome)
        || ![q.requestId, q.actorId, q.projectId, q.taskId, q.operationKey, q.attemptId, q.executionIdentity, evidence.id].every(localId)
        || !localRevision(evidence.revision) || !localTimestamp(q.qualifiedAt)
        || ![q.storeGeneration, q.subjectDigest, q.expectedState, q.evidenceDigest, ...Object.values(proof)].every(hex)
        || /^0+$/.test(q.storeGeneration))
        throw new LocalStoreError('invalid-record');
    return copy;
}
export function isReconciliationRecordId(id) { return id.startsWith('reconciliation-'); }
export function reconciliationDecisionId(q) {
    return `reconciliation-${digest(['action-gateway/reconciliation-decision/v1',
        q.projectId, q.taskId, q.operationKey, q.attemptId, q.executionIdentity])}`;
}
export function qualificationDigest(q) {
    return digest(['action-gateway/reconciliation-qualification/v1', q]);
}
export function reconciliationEventId(decisionId) {
    return `event-${digest(['action-gateway/reconciliation-audit/v1', decisionId, 1, 'reconciliation-decision-qualified'])}`;
}
export function parseReconciliationDecision(record) {
    const raw = localObject(record.payload, ['schemaVersion', 'phase', 'qualification', 'qualificationDigest',
        'runRevisionAtQualification', 'appliedAt']);
    const q = normalizeQualification(raw.qualification);
    if (record.kind !== actionAllowanceKind || record.digestVersion !== currentDigestVersion
        || record.projectId !== q.projectId || record.id !== reconciliationDecisionId(q)
        || raw.schemaVersion !== 'reconciliation-decision/v1' || raw.qualificationDigest !== qualificationDigest(q)
        || !localRevision(raw.runRevisionAtQualification)
        || (record.revision === 1 ? raw.phase !== 'qualified' || raw.appliedAt !== null
            : record.revision !== 2 || raw.phase !== 'applied' || !localTimestamp(raw.appliedAt) || raw.appliedAt < q.qualifiedAt)) {
        throw new LocalStoreError('invalid-record');
    }
    return Object.freeze({ ...raw, qualification: q });
}
export function sameQualification(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}
