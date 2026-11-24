import { computeSnapshotChecksum as digest, currentDigestVersion } from './digest.js'
import { actionAllowanceKind, copyLocalJson, localId, localObject, localRevision, localTimestamp,
  LocalStoreError, type LocalRecord } from './local-store.js'

type OutcomeProof =
  | Readonly<{ outcome: 'confirmed-effect'; proof: Readonly<{ effectOccurredDigest: string }> }>
  | Readonly<{ outcome: 'confirmed-no-effect'; proof: Readonly<{ effectAbsentDigest: string; attemptFinalityDigest: string }> }>

export type Qualification = OutcomeProof & Readonly<{
  requestId: string; actorId: string; projectId: string; taskId: string; operationKey: string
  attemptId: string; executionIdentity: string; storeGeneration: string; subjectDigest: string; expectedState: string
  evidenceRef: Readonly<{ id: string; revision: number }>; evidenceDigest: string; qualifiedAt: string
}>

export type ReconciliationPayload = Readonly<{
  schemaVersion: 'reconciliation-decision/v1'
  qualification: Qualification; qualificationDigest: string; runRevisionAtQualification: number
}> & (Readonly<{ phase: 'qualified'; appliedAt: null }> | Readonly<{ phase: 'applied'; appliedAt: string }>)

export type ReconciliationRecord = LocalRecord & Readonly<{ payload: ReconciliationPayload }>

function hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

export function normalizeQualification(value: unknown): Qualification {
  const copy = copyLocalJson(value)
  const q = localObject(copy, ['requestId', 'actorId', 'projectId', 'taskId', 'operationKey', 'attemptId',
    'executionIdentity', 'storeGeneration', 'subjectDigest', 'expectedState', 'outcome', 'evidenceRef',
    'evidenceDigest', 'proof', 'qualifiedAt'])
  const evidence = localObject(q.evidenceRef, ['id', 'revision'])
  const proofFields = q.outcome === 'confirmed-effect' ? ['effectOccurredDigest'] : ['effectAbsentDigest', 'attemptFinalityDigest']
  const proof = localObject(q.proof, proofFields)
  if (!['confirmed-effect', 'confirmed-no-effect'].includes(q.outcome as string)
    || ![q.requestId, q.actorId, q.projectId, q.taskId, q.operationKey, q.attemptId, q.executionIdentity, evidence.id].every(localId)
    || !localRevision(evidence.revision) || !localTimestamp(q.qualifiedAt)
    || ![q.storeGeneration, q.subjectDigest, q.expectedState, q.evidenceDigest, ...Object.values(proof)].every(hex)
    || /^0+$/.test(q.storeGeneration as string)) throw new LocalStoreError('invalid-record')
  return copy as Qualification
}

type DecisionIdentity = Pick<Qualification, 'projectId' | 'taskId' | 'operationKey' | 'attemptId' | 'executionIdentity'>

export function isReconciliationRecordId(id: string): boolean { return id.startsWith('reconciliation-') }

export function reconciliationDecisionId(q: DecisionIdentity): string {
  return `reconciliation-${digest(['action-gateway/reconciliation-decision/v1',
    q.projectId, q.taskId, q.operationKey, q.attemptId, q.executionIdentity])}`
}

export function qualificationDigest(q: Qualification): string {
  return digest(['action-gateway/reconciliation-qualification/v1', q])
}

export function reconciliationEventId(decisionId: string): string {
  return `event-${digest(['action-gateway/reconciliation-audit/v1', decisionId, 1, 'reconciliation-decision-qualified'])}`
}

export function parseReconciliationDecision(record: LocalRecord): ReconciliationPayload {
  const raw = localObject(record.payload, ['schemaVersion', 'phase', 'qualification', 'qualificationDigest',
    'runRevisionAtQualification', 'appliedAt'])
  const q = normalizeQualification(raw.qualification)
  if (record.kind !== actionAllowanceKind || record.digestVersion !== currentDigestVersion
    || record.projectId !== q.projectId || record.id !== reconciliationDecisionId(q)
    || raw.schemaVersion !== 'reconciliation-decision/v1' || raw.qualificationDigest !== qualificationDigest(q)
    || !localRevision(raw.runRevisionAtQualification)
    || (record.revision === 1 ? raw.phase !== 'qualified' || raw.appliedAt !== null
      : record.revision !== 2 || raw.phase !== 'applied' || !localTimestamp(raw.appliedAt) || raw.appliedAt < q.qualifiedAt)) {
    throw new LocalStoreError('invalid-record')
  }
  return Object.freeze({ ...raw, qualification: q }) as ReconciliationPayload
}

export function sameQualification(a: Qualification, b: Qualification): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
