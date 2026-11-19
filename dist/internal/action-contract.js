import { createTask, getRunNextAction } from './task-run.js';
const proposalKeys = ['schemaVersion', 'id', 'revision', 'projectId', 'taskId', 'runId',
    'runRevision', 'agentRef', 'actionRef', 'input', 'target'];
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const actionIdPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
class ProposalInputError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
function invalid(code) { throw new ProposalInputError(code); }
function validId(value) { return typeof value === 'string' && idPattern.test(value); }
function validRevision(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function validTimestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
        return false;
    const time = new Date(value);
    return Number.isFinite(time.getTime()) && time.toISOString() === value;
}
/** Reject unknown fields/accessors/prototypes rather than executing model-supplied objects. */
function record(input, code, keys) {
    if (typeof input !== 'object' || input === null || Array.isArray(input))
        invalid(code);
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null)
        invalid(code);
    const result = Object.create(null);
    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.length > 128)
        invalid(code);
    for (const key of ownKeys) {
        if (typeof key !== 'string' || !key || key.length > 128
            || ['__proto__', 'prototype', 'constructor'].includes(key) || (keys && !keys.includes(key)))
            invalid(code);
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !('value' in descriptor))
            invalid(code);
        result[key] = descriptor.value;
    }
    if (keys && keys.some((key) => !Object.hasOwn(result, key)))
        invalid(code);
    return result;
}
function readReference(input) {
    const value = record(input, 'invalid-proposal', ['id', 'revision']);
    if (!validId(value.id) || !validRevision(value.revision))
        invalid('invalid-proposal');
    return Object.freeze({ id: value.id, revision: value.revision });
}
/** Bounded JSON copying; no stringify hooks, sparse arrays, functions or SDK instances. */
function readValue(input, budget, depth = 0) {
    if (++budget.nodes > 1024 || depth > 8)
        invalid('invalid-input');
    if (input === null || typeof input === 'boolean')
        return input;
    if (typeof input === 'number' && Number.isFinite(input))
        return input;
    if (typeof input === 'string' && input.length <= 16_384)
        return input;
    if (Array.isArray(input)) {
        const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
        if (Object.getPrototypeOf(input) !== Array.prototype || !Number.isSafeInteger(length)
            || length > 128 || Reflect.ownKeys(input).length !== length + 1)
            invalid('invalid-input');
        const values = [];
        for (let i = 0; i < length; i += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
            if (!descriptor || !('value' in descriptor))
                invalid('invalid-input');
            values.push(readValue(descriptor.value, budget, depth + 1));
        }
        return Object.freeze(values);
    }
    const values = record(input, 'invalid-input');
    const copied = Object.create(null);
    for (const key of Object.keys(values).sort())
        copied[key] = readValue(values[key], budget, depth + 1);
    return Object.freeze(copied);
}
function readInput(input, definition) {
    const values = record(input, 'invalid-input');
    for (const key of Object.keys(values))
        if (!Object.hasOwn(definition.inputFields, key))
            invalid('invalid-input');
    for (const [key, field] of Object.entries(definition.inputFields)) {
        if (!Object.hasOwn(values, key)) {
            if (field.required)
                invalid('invalid-input');
            continue;
        }
        const value = values[key];
        const matches = field.type === 'array' ? Array.isArray(value)
            : field.type === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value)
                : typeof value === field.type;
        if (!matches || (field.type === 'string' && !value.trim()))
            invalid('invalid-input');
    }
    return readValue(values, { nodes: 0 });
}
function checkDefinition(definition) {
    if (definition.executionAvailable !== false || !validRevision(definition.revision)
        || !validId(definition.category) || !validId(definition.requiredCapability) || !validId(definition.targetKind)
        || !['low', 'medium', 'high', 'restricted'].includes(definition.riskLevel)
        || !['none', 'read', 'create', 'update', 'delete', 'execute'].includes(definition.sideEffect)
        || typeof definition.auditRequired !== 'boolean' || typeof definition.approvalMayBeRequired !== 'boolean') {
        invalid('invalid-context');
    }
    const fields = record(definition.inputFields, 'invalid-context');
    for (const value of Object.values(fields)) {
        const field = record(value, 'invalid-context', ['type', 'required']);
        if (!['string', 'number', 'boolean', 'object', 'array'].includes(field.type)
            || typeof field.required !== 'boolean')
            invalid('invalid-context');
    }
    if (definition.targetInputField !== undefined
        && (!Object.hasOwn(fields, definition.targetInputField)
            || definition.inputFields[definition.targetInputField].type !== 'string'))
        invalid('invalid-context');
}
/** No policy evaluation or side effect occurs here. The result is not executable authority. */
export function validateActionProposal(input, context) {
    try {
        const { task, run, agent, definitions, createdAt } = context;
        const profile = agent.declarativeProfile;
        if (!profile || profile.schemaVersion !== 'agent-profile/v0.1' || profile.executionAvailable !== false
            || !validRevision(profile.revision) || !validId(agent.id)
            || task.schemaVersion !== 'task/v0.1' || !createTask(task).ok
            || run.taskId !== task.id || run.projectId !== task.projectId
            || getRunNextAction(run) !== 'continue' || run.createdAt < task.createdAt
            || !Array.isArray(definitions) || new Set(definitions.map((item) => item.id)).size !== definitions.length) {
            return { ok: false, error: 'invalid-context' };
        }
        if (run.agentDefinitionRef.id !== agent.id || run.agentDefinitionRef.revision !== profile.revision) {
            return { ok: false, error: 'agent-mismatch' };
        }
        if (!validTimestamp(createdAt) || createdAt < run.updatedAt)
            return { ok: false, error: 'invalid-timestamp' };
        const raw = record(input, 'invalid-proposal', proposalKeys);
        if (raw.schemaVersion !== 'action-proposal/v0.1' || !validId(raw.id)
            || !validRevision(raw.revision) || !validRevision(raw.runRevision))
            invalid('invalid-proposal');
        if (raw.projectId !== task.projectId || raw.taskId !== task.id || raw.runId !== run.id)
            invalid('identity-mismatch');
        if (raw.runRevision !== run.revision)
            invalid('stale-run');
        const agentRef = readReference(raw.agentRef);
        const actionRef = readReference(raw.actionRef);
        if (agentRef.id !== agent.id || agentRef.revision !== profile.revision)
            invalid('agent-mismatch');
        const definition = definitions.find((item) => item.id === actionRef.id);
        if (!definition || !actionIdPattern.test(actionRef.id))
            invalid('unknown-action');
        if (definition.revision !== actionRef.revision)
            invalid('action-version-mismatch');
        checkDefinition(definition);
        if (!profile.actionIds.includes(definition.id) || !profile.capabilityIds.includes(definition.requiredCapability)) {
            invalid('undeclared-capability');
        }
        const argumentsValue = readInput(raw.input, definition);
        const target = record(raw.target, 'invalid-target', ['kind', 'resource']);
        if (target.kind !== definition.targetKind || typeof target.resource !== 'string'
            || !target.resource.trim() || target.resource.length > 2048
            || (definition.targetInputField && target.resource !== argumentsValue[definition.targetInputField]))
            invalid('invalid-target');
        return { ok: true, value: Object.freeze({ schemaVersion: 'action-proposal/v0.1', id: raw.id,
                revision: raw.revision, projectId: task.projectId, taskId: task.id, runId: run.id,
                runRevision: run.revision, agentRef, actionRef, input: argumentsValue,
                target: Object.freeze({ kind: definition.targetKind, resource: target.resource }), createdAt,
                category: definition.category, riskContext: Object.freeze({ riskLevel: definition.riskLevel,
                    sideEffect: definition.sideEffect, auditRequired: definition.auditRequired,
                    approvalMayBeRequired: definition.approvalMayBeRequired }), executionAvailable: false }) };
    }
    catch (error) {
        return { ok: false, error: error instanceof ProposalInputError ? error.code : 'invalid-proposal' };
    }
}
