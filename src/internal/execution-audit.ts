import { createHash } from 'node:crypto'

export type ExecutionAuditEventType = 'action-proposed' | 'policy-evaluated' | 'approval-requested'
  | 'approval-recorded' | 'execution-authority-granted' | 'execution-started'
  | 'execution-result-recorded' | 'reconciliation-started' | 'reconciliation-completed'
export type ExecutionAuditEvent = Readonly<{
  schemaVersion: 'execution-audit-event/v0.1'
  id: string; projectId: string; taskId: string; runId: string; occurredAt: string
  type: ExecutionAuditEventType; actorId: string; observationCode: string
  subjectRef: Readonly<{ kind: 'proposal' | 'run' | 'execution' | 'artifact'; id: string; revision: number }>
}>
export type ExecutionAuditEnvelope = Readonly<{
  schemaVersion: 'execution-audit-envelope/v0.1'; sequence: number; event: ExecutionAuditEvent
  previousHash: string | null; eventHash: string; chainHash: string
}>
/** The adapter exposes append only, never truncate/update; it serializes builders under a local lock. */
export type ExecutionAuditPort = Readonly<{
  read(): Promise<string>
  appendLine(build: (history: string) => string | null): Promise<string | null>
}>
export class ExecutionAuditError extends Error {
  readonly code: 'invalid-event' | 'corrupt-audit' | 'event-conflict'
  constructor(code: ExecutionAuditError['code']) { super(code); this.code = code }
}
const types: readonly ExecutionAuditEventType[] = ['action-proposed', 'policy-evaluated', 'approval-requested',
  'approval-recorded', 'execution-authority-granted', 'execution-started', 'execution-result-recorded',
  'reconciliation-started', 'reconciliation-completed']
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== keys.length) throw new ExecutionAuditError('invalid-event')
  const result: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) throw new ExecutionAuditError('invalid-event')
    result[key] = descriptor.value
  }
  return result
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)
}
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
export function validateExecutionAuditEvent(value: unknown): ExecutionAuditEvent {
  const raw = object(value, ['schemaVersion', 'id', 'projectId', 'taskId', 'runId', 'occurredAt',
    'type', 'actorId', 'observationCode', 'subjectRef'])
  const subject = object(raw.subjectRef, ['kind', 'id', 'revision'])
  if (raw.schemaVersion !== 'execution-audit-event/v0.1' || !id(raw.id) || !id(raw.projectId)
    || !raw.projectId.startsWith('project-') || !id(raw.taskId) || !raw.taskId.startsWith('task-')
    || !id(raw.runId) || !raw.runId.startsWith('run-') || !timestamp(raw.occurredAt)
    || !types.includes(raw.type as ExecutionAuditEventType) || !id(raw.actorId) || !id(raw.observationCode)
    || !['proposal', 'run', 'execution', 'artifact'].includes(subject.kind as string) || !id(subject.id)
    || typeof subject.revision !== 'number' || !Number.isSafeInteger(subject.revision) || subject.revision < 1) {
    throw new ExecutionAuditError('invalid-event')
  }
  return Object.freeze({ schemaVersion: 'execution-audit-event/v0.1', id: raw.id, projectId: raw.projectId,
    taskId: raw.taskId, runId: raw.runId, occurredAt: raw.occurredAt, type: raw.type as ExecutionAuditEventType,
    actorId: raw.actorId, observationCode: raw.observationCode, subjectRef: Object.freeze({
      kind: subject.kind as ExecutionAuditEvent['subjectRef']['kind'], id: subject.id, revision: subject.revision }) })
}
function envelope(event: ExecutionAuditEvent, sequence: number, previousHash: string | null): ExecutionAuditEnvelope {
  const eventHash = hash(JSON.stringify(event))
  return Object.freeze({ schemaVersion: 'execution-audit-envelope/v0.1', sequence, event, previousHash,
    eventHash, chainHash: hash(JSON.stringify([sequence, previousHash, eventHash])) })
}
export function readExecutionAudit(text: string, projectId: string): readonly ExecutionAuditEnvelope[] {
  if (!text) return Object.freeze([])
  try {
    if (!text.endsWith('\n') || Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error()
    const result: ExecutionAuditEnvelope[] = []
    const ids = new Set<string>()
    for (const line of text.slice(0, -1).split('\n')) {
      const raw = object(JSON.parse(line), ['schemaVersion', 'sequence', 'event', 'previousHash', 'eventHash', 'chainHash'])
      const event = validateExecutionAuditEvent(raw.event)
      const expected = envelope(event, result.length + 1, result.at(-1)?.chainHash ?? null)
      if (event.projectId !== projectId || ids.has(event.id) || raw.schemaVersion !== expected.schemaVersion
        || raw.sequence !== expected.sequence || raw.previousHash !== expected.previousHash
        || raw.eventHash !== expected.eventHash || raw.chainHash !== expected.chainHash) throw new Error()
      ids.add(event.id)
      result.push(expected)
    }
    return Object.freeze(result)
  } catch { throw new ExecutionAuditError('corrupt-audit') }
}
/** Historical observations only. Reading this log can never restore workflow or execution authority. */
export function createExecutionAuditStore(port: ExecutionAuditPort, projectId: string) {
  return Object.freeze({
    async read() { return readExecutionAudit(await port.read(), projectId) },
    async append(value: ExecutionAuditEvent): Promise<ExecutionAuditEnvelope> {
      const event = validateExecutionAuditEvent(value)
      if (event.projectId !== projectId) throw new ExecutionAuditError('invalid-event')
      let result: ExecutionAuditEnvelope | undefined
      await port.appendLine((history) => {
        const records = readExecutionAudit(history, projectId)
        const previous = records.find((entry) => entry.event.id === event.id)
        if (previous) {
          if (JSON.stringify(previous.event) !== JSON.stringify(event)) throw new ExecutionAuditError('event-conflict')
          result = previous
          return null
        }
        result = envelope(event, records.length + 1, records.at(-1)?.chainHash ?? null)
        return JSON.stringify(result)
      })
      if (!result) throw new ExecutionAuditError('corrupt-audit')
      return result
    },
  })
}
