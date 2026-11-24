import { createTaskAllowance } from './action-allowance.js'
import { computeSnapshotChecksum as digest, currentDigestVersion } from './digest.js'
import { createExecutionAuditStore, readExecutionAudit, validateExecutionAuditEvent,
  type ExecutionAuditEnvelope, type ExecutionAuditEvent, type ExecutionAuditPort } from './execution-audit.js'
import { actionAllowanceKind, isPairedReconciliationStore, localTimestamp, taskManifestId,
  LocalStoreError, type LocalRecord, type LocalRecordPort, type PairedReconciliationStore } from './local-store.js'
import { reconstructReconciliationSubject } from './reconciliation.js'
import { isReconciliationRecordId, normalizeQualification, parseReconciliationDecision, qualificationDigest,
  reconciliationDecisionId, reconciliationEventId, sameQualification,
  type Qualification, type ReconciliationRecord } from './reconciliation-record.js'
import { projectManifest, taskStoreIdentity } from './store-manifest.js'

type StateReader = Pick<LocalRecordPort, 'read' | 'list' | 'checksumFor'>
type AuditReader = Pick<ExecutionAuditPort, 'read'>

type Refusal = 'invalid-qualification' | 'promotion-required' | 'stale-state' | 'binding-mismatch'
  | 'ineligible' | 'request-conflict' | 'attempt-conflict' | 'invalid-clock' | 'corrupt-record'

export class ReconciliationDecisionError extends Error {
  constructor(readonly code: Refusal) { super(code) }
}

function refuse(code: Refusal): never { throw new ReconciliationDecisionError(code) }

function auditReferencesDecision(event: ExecutionAuditEvent): boolean {
  return event.type === 'reconciliation-decision-qualified'
    || (event.subjectRef?.kind === 'artifact' && typeof event.subjectRef.id === 'string'
      && isReconciliationRecordId(event.subjectRef.id))
}

export function hasReconciliationData(rows: readonly LocalRecord[], auditText: string): boolean {
  if (rows.some((row) => isReconciliationRecordId(row.id))) return true
  // Keep legacy receipt behavior on unrelated malformed audit data. A recognizable R3
  // observation still requires chain verification, even if its decision row is absent.
  if (!auditText.includes('reconciliation-') && !auditText.includes('\\')) return false
  return auditText.split('\n').some((line) => {
    try {
      const event = JSON.parse(line)?.event
      return event != null && auditReferencesDecision(event)
    } catch { return /"type"\s*:\s*"reconciliation-decision-qualified"/.test(line) }
  })
}

async function readManifest(state: StateReader, projectId: string) {
  const row = await state.read(actionAllowanceKind, taskManifestId)
  if (!row) refuse('corrupt-record')
  try {
    return projectManifest(row, projectId, (version) => state.checksumFor(version))
  } catch (error) {
    if (error instanceof LocalStoreError) throw error
    refuse('corrupt-record')
  }
}

function qualificationEvent(record: ReconciliationRecord, runId: string) {
  const { qualification: q, qualificationDigest: checksum } = record.payload
  return validateExecutionAuditEvent({
    schemaVersion: 'execution-audit-event/v0.1', id: reconciliationEventId(record.id),
    projectId: q.projectId, taskId: q.taskId, runId, actorId: q.actorId, occurredAt: q.qualifiedAt,
    type: 'reconciliation-decision-qualified', observationCode: `${q.outcome}:${checksum}`,
    subjectRef: { kind: 'artifact', id: record.id, revision: 1 },
  })
}

type ExpectedEvent = Readonly<{ event: ExecutionAuditEvent; required: boolean }>

function verifyQualificationEvents(history: readonly ExecutionAuditEnvelope[], expected: ReadonlyMap<string, ExpectedEvent>) {
  const byId = new Map([...expected.values()].map((entry) => [entry.event.id, entry]))
  const seen = new Set<string>()
  for (const { event } of history) {
    const association = byId.get(event.id)
    if (!association && !auditReferencesDecision(event)) continue
    if (!association || JSON.stringify(association.event) !== JSON.stringify(event) || seen.has(event.subjectRef.id)) refuse('corrupt-record')
    seen.add(event.subjectRef.id)
  }
  for (const [id, { required }] of expected) {
    if (required && !seen.has(id)) refuse('corrupt-record')
  }
}

function matchesSubject(q: Qualification, proof: Extract<Awaited<ReturnType<typeof reconstructReconciliationSubject>>, { status: 'eligible' }>) {
  const { subject, subjectDigest } = proof.result
  return q.projectId === subject.projectId && q.taskId === subject.taskId && q.operationKey === subject.operationKey
    && q.attemptId === subject.attemptId && q.attemptId === subject.binding.executionId
    && q.executionIdentity === subject.binding.executionIdentity && q.subjectDigest === subjectDigest
}

async function readDecisions(state: StateReader, history: string, projectId: string, rows: readonly LocalRecord[]) {
  const decisions = new Map<string, ReconciliationRecord>()
  const events = new Map<string, ExpectedEvent>()
  if (!hasReconciliationData(rows, history)) return { decisions, events }
  const manifest = await readManifest(state, projectId)
  if (manifest.storeGeneration === null) refuse('corrupt-record')
  const { taskId } = taskStoreIdentity(manifest.configuration.task.id)
  const audit = { read: async () => history }
  const journal = readExecutionAudit(history, projectId)
  const requests = new Set<string>()
  const attempts = new Set<string>()
  for (const row of rows) {
    if (!isReconciliationRecordId(row.id)) continue
    let payload
    try { payload = parseReconciliationDecision(row) } catch { refuse('corrupt-record') }
    const record = Object.freeze({ ...row, payload })
    const { qualification: q, runRevisionAtQualification, phase } = payload
    if (q.projectId !== projectId || q.taskId !== taskId || q.storeGeneration !== manifest.storeGeneration
      || decisions.has(q.operationKey) || attempts.has(q.attemptId) || requests.has(q.requestId)) refuse('corrupt-record')
    // Verify the recorded historical prefix. A prospective finalization separately
    // compares the live token, so a qualification cannot apply to an advanced Run.
    const proof = await reconstructReconciliationSubject(state, audit, projectId, q.operationKey, runRevisionAtQualification)
    if (proof.status !== 'eligible' || proof.result.observedPrefix !== 'reconciliation-required'
      || !matchesSubject(q, proof) || proof.result.expectedState !== q.expectedState
      || proof.historicalFloor > q.qualifiedAt) refuse('corrupt-record')
    events.set(record.id, { event: qualificationEvent(record, proof.result.subject.binding.runId), required: phase === 'applied' })
    decisions.set(q.operationKey, record)
    requests.add(q.requestId)
    attempts.add(q.attemptId)
  }
  verifyQualificationEvents(journal, events)
  return { decisions, events }
}

/** Callers consuming an existing decision must provide a fenced, durable state observation. */
export async function readReconciliationDecisions(
  state: StateReader, audit: AuditReader, projectId: string, rows?: readonly LocalRecord[],
): Promise<ReadonlyMap<string, ReconciliationRecord>> {
  return (await readDecisions(state, await audit.read(), projectId, rows ?? await state.list(actionAllowanceKind))).decisions
}

type QualificationHandle = Readonly<object>

export function createReconciliationDecisionKernel(
  { store, now }: Readonly<{ store: PairedReconciliationStore; now: () => string }>,
) {
  if (!isPairedReconciliationStore(store) || typeof now !== 'function') refuse('invalid-qualification')
  const { projectId, state, audit } = store
  const qualifications = new WeakMap<object, Qualification>()

  function issue(value: unknown): QualificationHandle {
    let q
    try { q = normalizeQualification(value) } catch { refuse('invalid-qualification') }
    const handle = Object.freeze(Object.create(null)) as QualificationHandle
    qualifications.set(handle, q)
    return handle
  }

  function sampleClock(): string {
    let sampled
    try { sampled = now() } catch { refuse('invalid-clock') }
    if (!localTimestamp(sampled)) refuse('invalid-clock')
    return sampled
  }

  async function apply(handle: unknown): Promise<ReconciliationRecord> {
    const q = handle !== null && typeof handle === 'object' ? qualifications.get(handle) : undefined
    if (!q) refuse('invalid-qualification')
    return state.exclusive(async (port) => {
      const manifest = await readManifest(port, projectId)
      if (manifest.storeGeneration === null) refuse('promotion-required')
      const { configuration } = manifest
      const { taskId } = taskStoreIdentity(configuration.task.id)
      const allowance = createTaskAllowance(projectId, taskId, configuration.task.cap, configuration)
      async function verifyAllowance(decisions: ReadonlyMap<string, ReconciliationRecord>) {
        try {
          await allowance.snapshot(port, undefined, decisions)
        } catch (error) {
          if (error instanceof LocalStoreError) throw error
          refuse('corrupt-record')
        }
      }
      const id = reconciliationDecisionId(q)
      const stateRows = await port.list(actionAllowanceKind)
      const hasDecisions = stateRows.some((row) => isReconciliationRecordId(row.id))
      if (hasDecisions) await port.syncDecisionDirectory()
      const existingHistory = await audit.read()
      const stored = await readDecisions(port, existingHistory, projectId,
        hasDecisions ? await port.list(actionAllowanceKind) : stateRows)
      const prior = [...stored.decisions.values()].find((row) => row.payload.qualification.requestId === q.requestId)
      if (prior && !sameQualification(prior.payload.qualification, q)) refuse('request-conflict')
      if (prior?.payload.phase === 'applied') {
        await verifyAllowance(stored.decisions)
        return prior
      }
      if (!prior && [...stored.decisions.values()].some((row) =>
        row.id === id || row.payload.qualification.attemptId === q.attemptId || row.payload.qualification.operationKey === q.operationKey)) {
        refuse('attempt-conflict')
      }
      if (q.projectId !== projectId || q.taskId !== taskId) refuse('binding-mismatch')
      if (q.storeGeneration !== manifest.storeGeneration) refuse('stale-state')
      const compareCurrent = async (history: string) => {
        const current = await readManifest(port, projectId)
        if (current.storeGeneration !== q.storeGeneration) refuse('stale-state')
        const proof = await reconstructReconciliationSubject(port, { read: async () => history }, projectId, q.operationKey)
        if (proof.status !== 'eligible' || proof.result.observedPrefix !== 'reconciliation-required') {
          refuse(prior && proof.status === 'ineligible' && proof.reason === 'unsupported-prefix' ? 'stale-state' : 'ineligible')
        }
        if (!matchesSubject(q, proof)) refuse('binding-mismatch')
        if (proof.result.expectedState !== q.expectedState) refuse('stale-state')
        return proof
      }

      readExecutionAudit(existingHistory, projectId)
      const proof = await compareCurrent(existingHistory)
      const start = sampleClock()
      if (q.qualifiedAt < proof.historicalFloor || q.qualifiedAt > start) refuse('invalid-clock')
      await verifyAllowance(stored.decisions)

      const qualified: ReconciliationRecord = prior ?? Object.freeze({
        kind: actionAllowanceKind, id, projectId, revision: 1, digestVersion: currentDigestVersion,
        payload: Object.freeze({
          schemaVersion: 'reconciliation-decision/v1', phase: 'qualified', appliedAt: null,
          qualification: q, qualificationDigest: qualificationDigest(q), runRevisionAtQualification: proof.runRevision,
        }),
      })
      if (!prior) await port.createDecision(qualified)
      stored.decisions.set(q.operationKey, qualified)
      const event = qualificationEvent(qualified, proof.result.subject.binding.runId)
      stored.events.set(id, { event, required: false })
      await createExecutionAuditStore(audit, projectId).append(event, (journal) => verifyQualificationEvents(journal, stored.events))
      stored.events.set(id, { event, required: true })

      const finalHistory = await audit.read()
      verifyQualificationEvents(readExecutionAudit(finalHistory, projectId), stored.events)
      const verified = await compareCurrent(finalHistory)
      if (verified.runRevision !== qualified.payload.runRevisionAtQualification) refuse('stale-state')
      const current = await port.read(actionAllowanceKind, id)
      if (!current || digest(current) !== digest(qualified)) refuse('corrupt-record')
      await verifyAllowance(stored.decisions)
      const final = sampleClock()
      if (final < start || final < q.qualifiedAt) refuse('invalid-clock')
      const applied: ReconciliationRecord = Object.freeze({ ...qualified, revision: 2,
        payload: Object.freeze({ ...qualified.payload, phase: 'applied', appliedAt: final }),
      })
      await port.applyDecision(applied)
      return applied
    })
  }

  return Object.freeze({ issuer: Object.freeze({ issue }), adjudicator: Object.freeze({ apply }) })
}
