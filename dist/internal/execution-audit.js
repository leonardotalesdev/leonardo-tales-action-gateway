import { createHash } from 'node:crypto';
export class ExecutionAuditError extends Error {
    code;
    constructor(code) { super(code); this.code = code; }
}
const types = ['action-proposed', 'policy-evaluated', 'approval-requested',
    'approval-recorded', 'execution-authority-granted', 'execution-started', 'execution-result-recorded',
    'reconciliation-started', 'reconciliation-completed', 'reconciliation-decision-qualified'];
function object(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Reflect.ownKeys(value).length !== keys.length)
        throw new ExecutionAuditError('invalid-event');
    const result = Object.create(null);
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor))
            throw new ExecutionAuditError('invalid-event');
        result[key] = descriptor.value;
    }
    return result;
}
function id(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
}
function timestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
        return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
export function validateExecutionAuditEvent(value) {
    const raw = object(value, ['schemaVersion', 'id', 'projectId', 'taskId', 'runId', 'occurredAt',
        'type', 'actorId', 'observationCode', 'subjectRef']);
    const subject = object(raw.subjectRef, ['kind', 'id', 'revision']);
    if (raw.schemaVersion !== 'execution-audit-event/v0.1' || !id(raw.id) || !id(raw.projectId)
        || !raw.projectId.startsWith('project-') || !id(raw.taskId) || !raw.taskId.startsWith('task-')
        || !id(raw.runId) || !raw.runId.startsWith('run-') || !timestamp(raw.occurredAt)
        || !types.includes(raw.type) || !id(raw.actorId) || !id(raw.observationCode)
        || !['proposal', 'run', 'execution', 'artifact'].includes(subject.kind) || !id(subject.id)
        || typeof subject.revision !== 'number' || !Number.isSafeInteger(subject.revision) || subject.revision < 1) {
        throw new ExecutionAuditError('invalid-event');
    }
    return Object.freeze({ schemaVersion: 'execution-audit-event/v0.1', id: raw.id, projectId: raw.projectId,
        taskId: raw.taskId, runId: raw.runId, occurredAt: raw.occurredAt, type: raw.type,
        actorId: raw.actorId, observationCode: raw.observationCode, subjectRef: Object.freeze({
            kind: subject.kind, id: subject.id, revision: subject.revision
        }) });
}
function envelope(event, sequence, previousHash) {
    const eventHash = hash(JSON.stringify(event));
    return Object.freeze({ schemaVersion: 'execution-audit-envelope/v0.1', sequence, event, previousHash,
        eventHash, chainHash: hash(JSON.stringify([sequence, previousHash, eventHash])) });
}
export function readExecutionAudit(text, projectId) {
    if (!text)
        return Object.freeze([]);
    try {
        if (!text.endsWith('\n') || Buffer.byteLength(text) > 16 * 1024 * 1024)
            throw new Error();
        const result = [];
        const ids = new Set();
        for (const line of text.slice(0, -1).split('\n')) {
            const raw = object(JSON.parse(line), ['schemaVersion', 'sequence', 'event', 'previousHash', 'eventHash', 'chainHash']);
            const event = validateExecutionAuditEvent(raw.event);
            const expected = envelope(event, result.length + 1, result.at(-1)?.chainHash ?? null);
            if (event.projectId !== projectId || ids.has(event.id) || raw.schemaVersion !== expected.schemaVersion
                || raw.sequence !== expected.sequence || raw.previousHash !== expected.previousHash
                || raw.eventHash !== expected.eventHash || raw.chainHash !== expected.chainHash)
                throw new Error();
            ids.add(event.id);
            result.push(expected);
        }
        return Object.freeze(result);
    }
    catch {
        throw new ExecutionAuditError('corrupt-audit');
    }
}
/** Historical observations only. Reading this log can never restore workflow or execution authority. */
export function createExecutionAuditStore(port, projectId) {
    return Object.freeze({
        async read() { return readExecutionAudit(await port.read(), projectId); },
        async append(value, verifyHistory) {
            const event = validateExecutionAuditEvent(value);
            if (event.projectId !== projectId)
                throw new ExecutionAuditError('invalid-event');
            let result;
            await port.appendLine((history) => {
                const records = readExecutionAudit(history, projectId);
                verifyHistory?.(records);
                const previous = records.find((entry) => entry.event.id === event.id);
                if (previous) {
                    if (JSON.stringify(previous.event) !== JSON.stringify(event))
                        throw new ExecutionAuditError('event-conflict');
                    result = previous;
                    return null;
                }
                result = envelope(event, records.length + 1, records.at(-1)?.chainHash ?? null);
                return JSON.stringify(result);
            });
            if (!result)
                throw new ExecutionAuditError('corrupt-audit');
            return result;
        },
    });
}
