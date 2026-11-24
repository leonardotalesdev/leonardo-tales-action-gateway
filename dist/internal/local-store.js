import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { computeRecordEnvelopeChecksum, computeSnapshotChecksum, createLegacySnapshotChecksum, currentDigestVersion, legacyDigestVersion, validateExplicitLegacyLocale } from './digest.js';
import { copyLocalJson, LocalStoreError, maxBytes, rejectLocalProxy } from './local-record.js';
import { isReconciliationRecordId, parseReconciliationDecision, sameQualification } from './reconciliation-record.js';
export { copyLocalJson, LocalStoreError } from './local-record.js';
const pairedStores = new WeakSet();
export function isPairedReconciliationStore(value) {
    return !!value && typeof value === 'object' && pairedStores.has(value);
}
/** Share the explicit R2 locale policy with private R3 storage composition. */
export function createExplicitStoreChecksum(locale, deferLocaleValidation = false) {
    if (locale !== undefined && !deferLocaleValidation)
        validateExplicitLegacyLocale(locale);
    let legacy;
    return (version) => {
        if (version === currentDigestVersion)
            return computeSnapshotChecksum;
        if (version !== legacyDigestVersion)
            throw new LocalStoreError('invalid-record');
        if (locale === undefined)
            throw new LocalStoreError('legacy-digest-locale-required');
        if (!legacy) {
            if (deferLocaleValidation)
                validateExplicitLegacyLocale(locale);
            legacy = createLegacySnapshotChecksum(locale);
        }
        return legacy;
    };
}
export const actionAllowanceKind = 'action-allowance';
export const taskManifestId = 'task-allowance';
const kinds = ['tasks', 'runs', 'execution', 'proposals', 'approval-requests', 'approval-decisions', 'gateway-attempts', actionAllowanceKind];
const immutableKinds = ['proposals', 'approval-requests', 'approval-decisions'];
const recordKeys = ['kind', 'id', 'projectId', 'revision', 'payload'];
function decisionRecord(record) {
    return record.kind === actionAllowanceKind && isReconciliationRecordId(record.id);
}
export function localId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
}
export function localRevision(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
export function localTimestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
        return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
export function localObject(value, keys) {
    rejectLocalProxy(value);
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new LocalStoreError('invalid-record');
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))) {
        throw new LocalStoreError('invalid-record');
    }
    const result = Object.create(null);
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor))
            throw new LocalStoreError('invalid-record');
        result[key] = descriptor.value;
    }
    return result;
}
function localRecord(value) {
    const raw = localObject(value, recordKeys);
    if (!localId(raw.id) || !localId(raw.projectId) || !String(raw.projectId).startsWith('project-'))
        throw new LocalStoreError('invalid-id');
    if (typeof raw.kind !== 'string' || !kinds.includes(raw.kind) || !localRevision(raw.revision))
        throw new LocalStoreError('invalid-record');
    return Object.freeze({ kind: raw.kind, id: raw.id, projectId: raw.projectId,
        revision: raw.revision, payload: copyLocalJson(raw.payload) });
}
function errno(error, code) { return error?.code === code; }
async function syncDirectory(path) {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
async function safeDirectory(path, create) {
    const root = parse(path).root;
    let current = root;
    for (const part of path.slice(root.length).split('/').filter(Boolean)) {
        current = join(current, part);
        let entry;
        try {
            entry = await lstat(current);
        }
        catch (error) {
            if (!create || !errno(error, 'ENOENT'))
                throw error;
            try {
                await mkdir(current, { mode: 0o700 });
            }
            catch (error) {
                if (!errno(error, 'EEXIST'))
                    throw error;
            }
            await syncDirectory(dirname(current));
            entry = await lstat(current);
        }
        if (!entry.isDirectory() || entry.isSymbolicLink())
            throw new LocalStoreError('unsafe-path');
    }
}
async function readBytes(path) {
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    catch (error) {
        if (errno(error, 'ENOENT'))
            return null;
        if (errno(error, 'ELOOP'))
            throw new LocalStoreError('unsafe-path');
        throw error;
    }
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes)
            throw new LocalStoreError('unsafe-path');
        return await handle.readFile();
    }
    finally {
        await handle.close();
    }
}
async function readText(path) {
    return (await readBytes(path))?.toString('utf8') ?? null;
}
export function canonicalGatewayPath(path) {
    return isAbsolute(path) && resolve(path) === path && path !== '/';
}
async function verifyGatewayDirectory(path) {
    await safeDirectory(path, false);
    const stat = await lstat(path);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
        throw new LocalStoreError('unsafe-path');
}
async function area(directory, projectId, options, create = true) {
    if (!isAbsolute(directory) || resolve(directory) !== directory || process.platform !== 'linux')
        throw new LocalStoreError('unsafe-path');
    if (!localId(projectId) || !projectId.startsWith('project-'))
        throw new LocalStoreError('invalid-id');
    const base = join(directory, computeSnapshotChecksum(projectId));
    await safeDirectory(base, create);
    const lockPath = join(base, '.writer.lock');
    async function writer(work) {
        await safeDirectory(base, false);
        let lock;
        try {
            lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        }
        catch (error) {
            if (errno(error, 'EEXIST'))
                throw new LocalStoreError('locked');
            throw error;
        }
        let uncertain = false;
        let active = true;
        const owner = await lock.stat();
        try {
            await lock.writeFile(JSON.stringify({ schemaVersion: 'local-writer-lock/v0.1', projectId }));
            await lock.sync();
            await syncDirectory(base);
            const replace = async (path, text) => {
                if (!active)
                    throw new LocalStoreError('locked');
                if (Buffer.byteLength(text) > maxBytes)
                    throw new LocalStoreError('invalid-record');
                await safeDirectory(dirname(path), false);
                const temporary = `${path}.tmp-${randomUUID()}`;
                let renamed = false;
                try {
                    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
                    try {
                        await handle.writeFile(text, 'utf8');
                        await handle.sync();
                    }
                    finally {
                        await handle.close();
                    }
                    await options.checkpoint?.('temporary-synced');
                    if (!active)
                        throw new LocalStoreError('locked');
                    await rename(temporary, path);
                    renamed = true;
                    await options.checkpoint?.('renamed');
                    await syncDirectory(dirname(path));
                    await options.checkpoint?.('directory-synced');
                }
                catch (error) {
                    if (renamed) {
                        uncertain = true;
                        throw new LocalStoreError('write-uncertain');
                    }
                    throw error;
                }
                finally {
                    if (!renamed)
                        await unlink(temporary).catch((error) => { if (!errno(error, 'ENOENT'))
                            throw error; });
                }
            };
            return await work(replace);
        }
        finally {
            active = false;
            await lock.close();
            if (!uncertain) {
                const named = await lstat(lockPath);
                if (named.ino !== owner.ino || named.dev !== owner.dev || named.isSymbolicLink())
                    throw new LocalStoreError('write-uncertain');
                await unlink(lockPath);
                await syncDirectory(base);
            }
        }
    }
    async function requireUnlocked() {
        await safeDirectory(base, false);
        try {
            await lstat(lockPath);
        }
        catch (error) {
            if (errno(error, 'ENOENT'))
                return;
            throw error;
        }
        throw new LocalStoreError('locked');
    }
    return { base, writer, requireUnlocked };
}
export function verifyRecordEnvelope(value, projectId, kind, checksumFor, id) {
    rejectLocalProxy(value);
    const schemaVersion = value && typeof value === 'object'
        ? Object.getOwnPropertyDescriptor(value, 'schemaVersion')?.value : undefined;
    const legacy = schemaVersion === 'local-record-envelope/v0.1';
    if (!legacy && schemaVersion !== 'local-record-envelope/v0.2')
        throw new LocalStoreError('corrupt-record');
    const raw = localObject(value, legacy ? ['schemaVersion', 'record', 'checksum']
        : ['schemaVersion', 'digestVersion', 'record', 'checksum']);
    const record = localRecord(raw.record);
    const digestVersion = legacy ? legacyDigestVersion : raw.digestVersion;
    if (digestVersion !== legacyDigestVersion && digestVersion !== currentDigestVersion)
        throw new LocalStoreError('corrupt-record');
    const checksum = legacy ? checksumFor(legacyDigestVersion)(record) : computeRecordEnvelopeChecksum({ schemaVersion, digestVersion, record });
    if (raw.checksum !== checksum || record.projectId !== projectId || record.kind !== kind
        || (id !== undefined && record.id !== id))
        throw new LocalStoreError('corrupt-record');
    const decoded = Object.freeze({ ...record, digestVersion });
    if (decisionRecord(record))
        parseReconciliationDecision(decoded);
    return { envelope: value, record: decoded };
}
function decodeRecord(text, projectId, kind, checksumFor, id) {
    try {
        return verifyRecordEnvelope(JSON.parse(text), projectId, kind, checksumFor, id);
    }
    catch (error) {
        if (error instanceof LocalStoreError && error.code === 'legacy-digest-locale-required')
            throw error;
        throw new LocalStoreError('corrupt-record');
    }
}
export function encodeRecordEnvelope(record, digestVersion = currentDigestVersion) {
    const body = { schemaVersion: 'local-record-envelope/v0.2', digestVersion, record };
    return { ...body, checksum: computeRecordEnvelopeChecksum(body) };
}
/** Explicit trusted-host storage adapter. No default path, agent tool or auto-recovery. */
export async function openLocalRecordStore(directory, projectId, options = {}) {
    const legacyChecksum = createLegacySnapshotChecksum(options.legacyDigestLocale);
    const checksumFor = (version) => {
        if (version === legacyDigestVersion)
            return legacyChecksum;
        if (version === currentDigestVersion)
            return computeSnapshotChecksum;
        throw new LocalStoreError('invalid-record');
    };
    const strictChecksumFor = createExplicitStoreChecksum(options.legacyDigestLocale, true);
    return openRecordStore(directory, projectId, options, checksumFor, strictChecksumFor, true);
}
async function openRecordStore(directory, projectId, options, checksumFor, strictChecksumFor, create) {
    const { base, writer } = await area(directory, projectId, options, create);
    if (create)
        for (const kind of kinds)
            await safeDirectory(join(base, kind), true);
    function pathFor(kind, id) {
        if (!kinds.includes(kind))
            throw new LocalStoreError('invalid-record');
        if (!localId(id))
            throw new LocalStoreError('invalid-id');
        return join(base, kind, `${computeSnapshotChecksum(id)}.json`);
    }
    function readRecord(text, kind, id, strict) {
        const { record } = decodeRecord(text, projectId, kind, strict ? strictChecksumFor : checksumFor, id);
        if (strict && record.digestVersion === legacyDigestVersion)
            strictChecksumFor(legacyDigestVersion);
        return record;
    }
    async function read(kind, id, strict = false) {
        const path = pathFor(kind, id);
        await safeDirectory(dirname(path), false);
        const text = await readText(path);
        if (text === null)
            return null;
        return readRecord(text, kind, id, strict);
    }
    async function write(value, expected, replace) {
        // Checking for the optional version probes the write envelope before localObject.
        rejectLocalProxy(value);
        const keys = value && Object.hasOwn(value, 'digestVersion') ? [...recordKeys, 'digestVersion'] : recordKeys;
        const { digestVersion, ...body } = localObject(value, keys);
        const record = localRecord(body);
        if (record.projectId !== projectId)
            throw new LocalStoreError('invalid-record');
        const previous = await read(record.kind, record.id);
        if (expected === null) {
            if (previous)
                throw new LocalStoreError('already-exists');
            if (record.revision !== 1)
                throw new LocalStoreError('invalid-record');
        }
        else {
            if (immutableKinds.includes(record.kind) || (record.kind === actionAllowanceKind && record.id === taskManifestId))
                throw new LocalStoreError('already-exists');
            if (!localRevision(expected) || !previous || previous.revision !== expected
                || !localRevision(expected + 1) || record.revision !== expected + 1)
                throw new LocalStoreError('stale-revision');
        }
        const version = digestVersion ?? previous?.digestVersion ?? currentDigestVersion;
        if ((version !== legacyDigestVersion && version !== currentDigestVersion)
            || (previous && version !== previous.digestVersion))
            throw new LocalStoreError('invalid-record');
        if (decisionRecord(record)) {
            const nextDecision = parseReconciliationDecision({ ...record, digestVersion: version });
            if (previous) {
                const priorDecision = parseReconciliationDecision(previous);
                if (previous.revision !== 1 || record.revision !== 2
                    || priorDecision.qualificationDigest !== nextDecision.qualificationDigest
                    || priorDecision.runRevisionAtQualification !== nextDecision.runRevisionAtQualification
                    || !sameQualification(priorDecision.qualification, nextDecision.qualification)) {
                    throw new LocalStoreError('invalid-record');
                }
            }
        }
        await replace(pathFor(record.kind, record.id), `${JSON.stringify(encodeRecordEnvelope(record, version))}\n`);
    }
    async function list(kind, strict = false) {
        pathFor(kind, 'validate-id');
        await safeDirectory(join(base, kind), false);
        const results = [];
        for (const name of (await readdir(join(base, kind))).sort()) {
            if (!/^[a-f0-9]{64}\.json$/.test(name))
                continue;
            const text = await readText(join(base, kind, name));
            try {
                const record = readRecord(text, kind, undefined, strict);
                if (`${computeSnapshotChecksum(record.id)}.json` !== name)
                    throw new Error();
                results.push(record);
            }
            catch (error) {
                if (strict && error instanceof LocalStoreError && error.code === 'legacy-digest-locale-required')
                    throw error;
                throw new LocalStoreError('corrupt-record');
            }
        }
        return Object.freeze(results);
    }
    return Object.freeze({ checksumFor, read, list,
        create: (record) => writer((replace) => write(record, null, replace)),
        save: (record, expectedRevision) => writer((replace) => write(record, expectedRevision, replace)),
        exclusive: (work) => writer(async (replace) => {
            let active = true;
            function check() { if (!active)
                throw new LocalStoreError('locked'); }
            function history(strict) {
                return Object.freeze({
                    checksumFor: (version) => { check(); return (strict ? strictChecksumFor : checksumFor)(version); },
                    read: async (kind, id) => { check(); const result = await read(kind, id, strict); check(); return result; },
                    list: async (kind) => { check(); const result = await list(kind, strict); check(); return result; },
                });
            }
            const scoped = Object.freeze({
                ...history(false),
                strictHistory: history(true),
                async syncDecisionDirectory() {
                    check();
                    const directory = join(base, actionAllowanceKind);
                    await safeDirectory(directory, false);
                    await syncDirectory(directory);
                    check();
                },
                create: async (record) => { check(); await write(record, null, replace); },
                save: async (record, expected) => { check(); await write(record, expected, replace); },
            });
            try {
                return await work(scoped);
            }
            finally {
                active = false;
            }
        }),
    });
}
/** Append-only API; full-file atomic replacement keeps partial JSONL tails out of history. */
export async function openLocalAuditPort(directory, projectId, options = {}) {
    return openAuditPort(directory, projectId, options, true);
}
async function openAuditPort(directory, projectId, options, create) {
    const { base, writer } = await area(directory, projectId, options, create);
    const path = join(base, 'events.jsonl');
    async function read() { await safeDirectory(base, false); return (await readText(path)) ?? ''; }
    return Object.freeze({ read, async appendLine(build) {
            return writer(async (replace) => {
                const history = await read();
                const line = build(history);
                if (line === null)
                    return null;
                if (typeof line !== 'string' || !line || /[\r\n]/.test(line))
                    throw new LocalStoreError('invalid-record');
                await replace(path, `${history}${line}\n`);
                return line;
            });
        } });
}
/** Pair existing state and audit beneath one verified Task directory. */
export async function openReconciliationStore(directory, projectId, options = {}) {
    if (!canonicalGatewayPath(directory))
        throw new LocalStoreError('unsafe-path');
    await verifyGatewayDirectory(directory);
    const checksumFor = createExplicitStoreChecksum(options.legacyDigestLocale, true);
    const state = await openRecordStore(join(directory, 'state'), projectId, { checkpoint: options.stateCheckpoint }, checksumFor, checksumFor, false);
    const audit = await openAuditPort(join(directory, 'audit'), projectId, { checkpoint: options.auditCheckpoint }, false);
    const store = Object.freeze({
        projectId,
        state: Object.freeze({
            exclusive: (work) => state.exclusive((port) => work(Object.freeze({
                ...port.strictHistory,
                syncDecisionDirectory: port.syncDecisionDirectory,
                async createDecision(record) {
                    if (!decisionRecord(record) || record.revision !== 1)
                        throw new LocalStoreError('invalid-record');
                    await port.create(record);
                },
                async applyDecision(record) {
                    if (!decisionRecord(record) || record.revision !== 2)
                        throw new LocalStoreError('invalid-record');
                    await port.save(record, 1);
                },
            }))),
        }),
        audit,
    });
    pairedStores.add(store);
    return store;
}
/** Existing Task paths only. The writer can replace just the canonical manifest. */
export async function openExistingPromotionStore(directory, projectId, checksumFor, options) {
    if (!canonicalGatewayPath(directory))
        throw new LocalStoreError('unsafe-path');
    await verifyGatewayDirectory(directory);
    const state = await area(join(directory, 'state'), projectId, options, false);
    const audit = await area(join(directory, 'audit'), projectId, {}, false);
    const manifestDirectory = join(state.base, actionAllowanceKind);
    const manifestPath = join(manifestDirectory, `${computeSnapshotChecksum(taskManifestId)}.json`);
    async function snapshot() {
        const fingerprint = createHash('sha256');
        const records = new Map();
        for (const kind of kinds) {
            const collection = join(state.base, kind);
            let names;
            try {
                await safeDirectory(collection, false);
                names = (await readdir(collection)).sort();
            }
            catch (error) {
                if (!errno(error, 'ENOENT'))
                    throw error;
                names = [];
            }
            const rows = [];
            records.set(kind, rows);
            for (const name of names) {
                if (!/^[a-f0-9]{64}\.json$/.test(name))
                    continue;
                const bytes = await readBytes(join(collection, name));
                if (!bytes)
                    throw new LocalStoreError('stale-revision');
                const row = decodeRecord(bytes.toString('utf8'), projectId, kind, checksumFor);
                if (`${computeSnapshotChecksum(row.record.id)}.json` !== name)
                    throw new LocalStoreError('corrupt-record');
                fingerprint.update(JSON.stringify([kind, name, bytes.length])).update(bytes);
                rows.push(row);
            }
        }
        await safeDirectory(audit.base, false);
        const history = await readBytes(join(audit.base, 'events.jsonl'));
        fingerprint.update(JSON.stringify(history?.length ?? null));
        if (history)
            fingerprint.update(history);
        return { records, audit: history?.toString('utf8') ?? '', fingerprint: fingerprint.digest('hex') };
    }
    async function readManifest() {
        await safeDirectory(manifestDirectory, false);
        const text = await readText(manifestPath);
        if (text === null)
            throw new LocalStoreError('stale-revision');
        return decodeRecord(text, projectId, actionAllowanceKind, checksumFor, taskManifestId);
    }
    return {
        snapshot,
        requireStateUnlocked: state.requireUnlocked,
        requireAuditUnlocked: audit.requireUnlocked,
        exclusive(work) {
            return state.writer((replace) => work({
                read: readManifest,
                replace: (candidate) => replace(manifestPath, `${JSON.stringify(candidate)}\n`),
                sync: () => syncDirectory(manifestDirectory),
            }));
        },
    };
}
