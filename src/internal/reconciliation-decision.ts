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
type EligibleSubject = Extract<Awaited<ReturnType<typeof reconstructReconciliationSubject>>, { status: 'eligible' }>
type DecisionReader = StateReader & Readonly<{ syncDecisionDirectory(): Promise<void> }>

type Refusal = 'invalid-qualification' | 'promotion-required' | 'stale-state' | 'binding-mismatch'
  | 'ineligible' | 'request-conflict' | 'attempt-conflict' | 'invalid-clock' | 'corrupt-record' | 'store-not-found'

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

function projectStoredManifest(state: StateReader, projectId: string, row: LocalRecord) {
  try {
    return projectManifest(row, projectId, (version) => state.checksumFor(version))
  } catch (error) {
    if (error instanceof LocalStoreError) throw error
    refuse('corrupt-record')
  }
}

async function readManifest(state: StateReader, projectId: string) {
  const row = await state.read(actionAllowanceKind, taskManifestId)
  if (!row) refuse('corrupt-record')
  return projectStoredManifest(state, projectId, row)
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

function matchesSubject(q: Qualification, proof: EligibleSubject) {
  const { subject, subjectDigest } = proof.result
  return q.projectId === subject.projectId && q.taskId === subject.taskId && q.operationKey === subject.operationKey
    && q.attemptId === subject.attemptId && q.attemptId === subject.binding.executionId
    && q.executionIdentity === subject.binding.executionIdentity && q.subjectDigest === subjectDigest
}

async function reconstructObservedSubject(
  state: StateReader, audit: AuditReader, projectId: string, operationKey: string, runRevision?: number,
) {
  // R1 deliberately collapses history failures. The host boundary still needs to
  // distinguish strict store-read failures from structurally invalid history.
  let readFailure: unknown
  function remember(error: unknown): never {
    readFailure = error
    throw error
  }
  const proof = await reconstructReconciliationSubject({
    read: (kind, id) => state.read(kind, id).catch(remember),
    checksumFor(version) {
      try { return state.checksumFor(version) } catch (error) { return remember(error) }
    },
  }, audit, projectId, operationKey, runRevision)
  if (readFailure !== undefined) throw readFailure
  return proof
}

async function readDecisions(state: StateReader, history: string, projectId: string, rows: readonly LocalRecord[],
  journal?: readonly ExecutionAuditEnvelope[],
) {
  const decisions = new Map<string, ReconciliationRecord>()
  const events = new Map<string, ExpectedEvent>()
  const hasData = journal
    ? rows.some((row) => isReconciliationRecordId(row.id)) || journal.some(({ event }) => auditReferencesDecision(event))
    : hasReconciliationData(rows, history)
  if (!hasData) return { decisions, events }
  const manifest = await readManifest(state, projectId)
  if (manifest.storeGeneration === null) refuse('corrupt-record')
  const { taskId } = taskStoreIdentity(manifest.configuration.task.id)
  const audit = { read: async () => history }
  const verifiedJournal = journal ?? readExecutionAudit(history, projectId)
  const reconstruct = journal ? reconstructObservedSubject : reconstructReconciliationSubject
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
    const proof = await reconstruct(state, audit, projectId, q.operationKey, runRevisionAtQualification)
    if (proof.status !== 'eligible' || proof.result.observedPrefix !== 'reconciliation-required'
      || !matchesSubject(q, proof) || proof.result.expectedState !== q.expectedState
      || proof.historicalFloor > q.qualifiedAt) refuse('corrupt-record')
    events.set(record.id, { event: qualificationEvent(record, proof.result.subject.binding.runId), required: phase === 'applied' })
    decisions.set(q.operationKey, record)
    requests.add(q.requestId)
    attempts.add(q.attemptId)
  }
  verifyQualificationEvents(verifiedJournal, events)
  return { decisions, events }
}

/** Callers consuming an existing decision must provide a fenced, durable state observation. */
export async function readReconciliationDecisions(
  state: StateReader, audit: AuditReader, projectId: string, rows?: readonly LocalRecord[],
): Promise<ReadonlyMap<string, ReconciliationRecord>> {
  return (await readDecisions(state, await audit.read(), projectId, rows ?? await state.list(actionAllowanceKind))).decisions
}

type QualificationHandle = Readonly<object>
type ObservationRequest = Pick<Qualification, 'requestId' | 'actorId' | 'operationKey' | 'evidenceRef' | 'storeGeneration'>
type Observation = Readonly<{ status: 'replayed'; record: ReconciliationRecord }>
  | Readonly<{ status: 'eligible'; result: EligibleSubject['result'] }>
type ApplyDisposition = Readonly<{ status: 'applied' | 'replayed'; record: ReconciliationRecord }>

function findPrior(
  decisions: ReadonlyMap<string, ReconciliationRecord>, requestId: string, matches: (q: Qualification) => boolean,
) {
  const prior = [...decisions.values()].find((row) => row.payload.qualification.requestId === requestId)
  if (prior && !matches(prior.payload.qualification)) refuse('request-conflict')
  return prior
}

function requireUnoccupied(
  decisions: ReadonlyMap<string, ReconciliationRecord>, operationKey: string, attemptId?: string, decisionId?: string,
) {
  if (decisions.has(operationKey) || (attemptId !== undefined && [...decisions.values()].some((row) =>
    row.id === decisionId || row.payload.qualification.attemptId === attemptId))) refuse('attempt-conflict')
}

async function verifyAllowance(
  port: StateReader, allowance: ReturnType<typeof createTaskAllowance>,
  decisions: ReadonlyMap<string, ReconciliationRecord>, rows?: readonly LocalRecord[],
) {
  try {
    await allowance.snapshot(port, undefined, decisions, rows)
  } catch (error) {
    if (error instanceof LocalStoreError) throw error
    refuse('corrupt-record')
  }
}

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

  async function readFencedDecisions(port: DecisionReader, verifyJournal = false) {
    const stateRows = await port.list(actionAllowanceKind)
    const hasDecisions = stateRows.some((row) => isReconciliationRecordId(row.id))
    if (hasDecisions) await port.syncDecisionDirectory()
    const history = await audit.read()
    const rows = hasDecisions ? await port.list(actionAllowanceKind) : stateRows
    const journal = verifyJournal ? readExecutionAudit(history, projectId) : undefined
    return { history, rows, ...await readDecisions(port, history, projectId, rows, journal) }
  }

  async function validateStore(originalTaskId: string): Promise<string> {
    return state.exclusive(async (port) => {
      const row = await port.read(actionAllowanceKind, taskManifestId)
      if (!row) {
        for (const kind of [actionAllowanceKind, 'tasks', 'runs', 'execution', 'proposals',
          'approval-requests', 'approval-decisions', 'gateway-attempts']) {
          if ((await port.list(kind)).length) refuse('corrupt-record')
        }
        if (await audit.read()) refuse('corrupt-record')
        refuse('store-not-found')
      }
      const manifest = projectStoredManifest(port, projectId, row)
      if (manifest.configuration.task.id !== originalTaskId) refuse('corrupt-record')
      if (manifest.storeGeneration === null) refuse('promotion-required')
      return manifest.storeGeneration
    })
  }

  async function observe(request: ObservationRequest): Promise<Observation> {
    return state.exclusive(async (port) => {
      const manifest = await readManifest(port, projectId)
      if (manifest.storeGeneration === null) refuse('promotion-required')
      if (manifest.storeGeneration !== request.storeGeneration) refuse('stale-state')
      const { configuration } = manifest
      const { taskId } = taskStoreIdentity(configuration.task.id)
      const allowance = createTaskAllowance(projectId, taskId, configuration.task.cap, configuration)
      const { history, rows, decisions } = await readFencedDecisions(port, true)
      await verifyAllowance(port, allowance, decisions, rows)

      const prior = findPrior(decisions, request.requestId, (q) =>
        q.actorId === request.actorId && q.operationKey === request.operationKey
        && q.evidenceRef.id === request.evidenceRef.id && q.evidenceRef.revision === request.evidenceRef.revision)
      if (prior?.payload.phase === 'applied') return Object.freeze({ status: 'replayed', record: prior })
      if (!prior) requireUnoccupied(decisions, request.operationKey)

      const proof = await reconstructObservedSubject(port, { read: async () => history }, projectId, request.operationKey)
      if (proof.status !== 'eligible') {
        if (proof.reason === 'invalid-history') refuse('corrupt-record')
        refuse(prior && proof.reason === 'unsupported-prefix' ? 'stale-state' : 'ineligible')
      }
      if (proof.result.observedPrefix !== 'reconciliation-required') refuse('ineligible')
      if (prior) {
        const q = prior.payload.qualification
        if (!matchesSubject(q, proof) || q.expectedState !== proof.result.expectedState) refuse('stale-state')
      } else {
        requireUnoccupied(decisions, request.operationKey, proof.result.subject.attemptId)
      }
      return Object.freeze({ status: 'eligible', result: proof.result })
    })
  }

  async function applyDecision(handle: unknown, diagnoseHistory: boolean): Promise<ApplyDisposition> {
    const q = handle !== null && typeof handle === 'object' ? qualifications.get(handle) : undefined
    if (!q) refuse('invalid-qualification')
    return state.exclusive(async (port) => {
      const manifest = await readManifest(port, projectId)
      if (manifest.storeGeneration === null) refuse('promotion-required')
      const { configuration } = manifest
      const { taskId } = taskStoreIdentity(configuration.task.id)
      const allowance = createTaskAllowance(projectId, taskId, configuration.task.cap, configuration)
      const id = reconciliationDecisionId(q)
      const stored = await readFencedDecisions(port, diagnoseHistory)
      const prior = findPrior(stored.decisions, q.requestId, (storedQ) => sameQualification(storedQ, q))
      if (prior?.payload.phase === 'applied') {
        await verifyAllowance(port, allowance, stored.decisions)
        return Object.freeze({ status: 'replayed', record: prior })
      }
      if (!prior) requireUnoccupied(stored.decisions, q.operationKey, q.attemptId, id)
      if (q.projectId !== projectId || q.taskId !== taskId) refuse('binding-mismatch')
      if (q.storeGeneration !== manifest.storeGeneration) refuse('stale-state')
      const compareCurrent = async (history: string) => {
        const current = await readManifest(port, projectId)
        if (current.storeGeneration !== q.storeGeneration) refuse('stale-state')
        const reconstruct = diagnoseHistory ? reconstructObservedSubject : reconstructReconciliationSubject
        const proof = await reconstruct(port, { read: async () => history }, projectId, q.operationKey)
        if (proof.status !== 'eligible' || proof.result.observedPrefix !== 'reconciliation-required') {
          if (diagnoseHistory && proof.status === 'ineligible' && proof.reason === 'invalid-history') refuse('corrupt-record')
          refuse(prior && proof.status === 'ineligible' && proof.reason === 'unsupported-prefix' ? 'stale-state' : 'ineligible')
        }
        if (!matchesSubject(q, proof)) refuse('binding-mismatch')
        if (proof.result.expectedState !== q.expectedState) refuse('stale-state')
        return proof
      }

      if (!diagnoseHistory) readExecutionAudit(stored.history, projectId)
      const proof = await compareCurrent(stored.history)
      const start = sampleClock()
      if (q.qualifiedAt < proof.historicalFloor || q.qualifiedAt > start) refuse('invalid-clock')
      await verifyAllowance(port, allowance, stored.decisions)

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
      await verifyAllowance(port, allowance, stored.decisions)
      const final = sampleClock()
      if (final < start || final < q.qualifiedAt) refuse('invalid-clock')
      const applied: ReconciliationRecord = Object.freeze({ ...qualified, revision: 2,
        payload: Object.freeze({ ...qualified.payload, phase: 'applied', appliedAt: final }),
      })
      await port.applyDecision(applied)
      return Object.freeze({ status: 'applied', record: applied })
    })
  }

  async function apply(handle: unknown): Promise<ReconciliationRecord> {
    return (await applyDecision(handle, false)).record
  }

  function applyWithDisposition(handle: unknown): Promise<ApplyDisposition> {
    return applyDecision(handle, true)
  }

  return Object.freeze({ validateStore, observe, issuer: Object.freeze({ issue }),
    adjudicator: Object.freeze({ apply, applyWithDisposition }),
  })
}
