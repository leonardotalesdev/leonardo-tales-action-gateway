import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { computeSnapshotChecksum, createLegacySnapshotChecksum, currentDigestVersion, legacyDigestVersion,
  type DigestVersion, type SnapshotChecksum } from './digest.js'

export type LocalStoreErrorCode = 'invalid-record' | 'invalid-id' | 'unsafe-path' | 'locked'
  | 'already-exists' | 'stale-revision' | 'corrupt-record' | 'write-uncertain' | 'io-error'
export class LocalStoreError extends Error {
  readonly code: LocalStoreErrorCode
  constructor(code: LocalStoreErrorCode) { super(code); this.code = code }
}
type RecordBody = Readonly<{
  kind: string; id: string; projectId: string; revision: number; payload: unknown
}>
export type LocalRecord = RecordBody & Readonly<{ digestVersion: DigestVersion }>
type RecordWrite = RecordBody & Readonly<{ digestVersion?: DigestVersion }>
export type LocalRecordPort = Readonly<{
  checksumFor(version: DigestVersion): SnapshotChecksum
  read(kind: string, id: string): Promise<LocalRecord | null>
  list(kind: string): Promise<readonly LocalRecord[]>
  create(record: RecordWrite): Promise<void>
  save(record: RecordWrite, expectedRevision: number): Promise<void>
}>
/** Trusted host critical section. Its scoped port expires when the callback settles. */
export type LocalTransactionalRecordPort = LocalRecordPort & Readonly<{
  exclusive<T>(work: (port: LocalRecordPort) => Promise<T>): Promise<T>
}>
export type LocalAuditPort = Readonly<{
  read(): Promise<string>
  appendLine(build: (history: string) => string | null): Promise<string | null>
}>
/** Fault-injection checkpoints for offline tests, never supplied by an agent. */
export type LocalStoreOptions = Readonly<{
  checkpoint?: (stage: 'temporary-synced' | 'renamed' | 'directory-synced') => void | Promise<void>
}>

export const actionAllowanceKind = 'action-allowance'
const kinds = ['tasks', 'runs', 'execution', 'proposals', 'approval-requests', 'approval-decisions', 'gateway-attempts', actionAllowanceKind]
const immutableKinds = ['proposals', 'approval-requests', 'approval-decisions']
const recordKeys = ['kind', 'id', 'projectId', 'revision', 'payload']
const maxBytes = 16 * 1024 * 1024
export function localId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)
}
export function localRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
export function localTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}
export function localObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new LocalStoreError('invalid-record')
  const own = Reflect.ownKeys(value)
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw new LocalStoreError('invalid-record')
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) throw new LocalStoreError('invalid-record')
    result[key] = descriptor.value
  }
  return result
}
/** Strict JSON boundary before hashing or writing a record. */
export function copyLocalJson(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (++budget.nodes > 100_000 || depth > 32) throw new LocalStoreError('invalid-record')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string' && value.length <= maxBytes) return value
  // Match the persisted JSON number before a caller can hash or meter the copy.
  if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value
  if (Array.isArray(value)) {
    if (value.length > 50_000 || Reflect.ownKeys(value).length !== value.length + 1) throw new LocalStoreError('invalid-record')
    const result: unknown[] = []
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
      if (!descriptor || !('value' in descriptor)) throw new LocalStoreError('invalid-record')
      result.push(copyLocalJson(descriptor.value, depth + 1, budget))
    }
    return Object.freeze(result)
  }
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new LocalStoreError('invalid-record')
  }
  const result: Record<string, unknown> = Object.create(null)
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string')) throw new LocalStoreError('invalid-record')
  for (const key of (keys as string[]).sort()) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new LocalStoreError('invalid-record')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) throw new LocalStoreError('invalid-record')
    result[key] = copyLocalJson(descriptor.value, depth + 1, budget)
  }
  return Object.freeze(result)
}
function localRecord(value: unknown): RecordBody {
  const raw = localObject(value, recordKeys)
  if (!localId(raw.id) || !localId(raw.projectId) || !String(raw.projectId).startsWith('project-')) throw new LocalStoreError('invalid-id')
  if (typeof raw.kind !== 'string' || !kinds.includes(raw.kind) || !localRevision(raw.revision)) throw new LocalStoreError('invalid-record')
  return Object.freeze({ kind: raw.kind, id: raw.id, projectId: raw.projectId,
    revision: raw.revision, payload: copyLocalJson(raw.payload) })
}
function errno(error: unknown, code: string): boolean { return (error as NodeJS.ErrnoException)?.code === code }
async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}
async function safeDirectory(path: string, create: boolean): Promise<void> {
  const root = parse(path).root
  let current = root
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part)
    let entry
    try { entry = await lstat(current) }
    catch (error) {
      if (!create || !errno(error, 'ENOENT')) throw error
      try { await mkdir(current, { mode: 0o700 }) } catch (error) { if (!errno(error, 'EEXIST')) throw error }
      await syncDirectory(dirname(current))
      entry = await lstat(current)
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new LocalStoreError('unsafe-path')
  }
}
async function readText(path: string): Promise<string | null> {
  let handle
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    if (errno(error, 'ENOENT')) return null
    if (errno(error, 'ELOOP')) throw new LocalStoreError('unsafe-path')
    throw error
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new LocalStoreError('unsafe-path')
    return await handle.readFile('utf8')
  } finally { await handle.close() }
}

async function area(directory: string, projectId: string, options: LocalStoreOptions) {
  if (!isAbsolute(directory) || resolve(directory) !== directory || process.platform !== 'linux') throw new LocalStoreError('unsafe-path')
  if (!localId(projectId) || !projectId.startsWith('project-')) throw new LocalStoreError('invalid-id')
  const base = join(directory, computeSnapshotChecksum(projectId))
  await safeDirectory(base, true)
  const lockPath = join(base, '.writer.lock')
  async function writer<T>(work: (replace: (path: string, text: string) => Promise<void>) => Promise<T>): Promise<T> {
    await safeDirectory(base, false)
    let lock
    try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
    catch (error) { if (errno(error, 'EEXIST')) throw new LocalStoreError('locked'); throw error }
    let uncertain = false
    let active = true
    const owner = await lock.stat()
    try {
      await lock.writeFile(JSON.stringify({ schemaVersion: 'local-writer-lock/v0.1', projectId }))
      await lock.sync()
      await syncDirectory(base)
      const replace = async (path: string, text: string) => {
        if (!active) throw new LocalStoreError('locked')
        if (Buffer.byteLength(text) > maxBytes) throw new LocalStoreError('invalid-record')
        await safeDirectory(dirname(path), false)
        const temporary = `${path}.tmp-${randomUUID()}`
        let renamed = false
        try {
          const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
          try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
          await options.checkpoint?.('temporary-synced')
          if (!active) throw new LocalStoreError('locked')
          await rename(temporary, path)
          renamed = true
          await options.checkpoint?.('renamed')
          await syncDirectory(dirname(path))
          await options.checkpoint?.('directory-synced')
        } catch (error) {
          if (renamed) { uncertain = true; throw new LocalStoreError('write-uncertain') }
          throw error
        } finally {
          if (!renamed) await unlink(temporary).catch((error) => { if (!errno(error, 'ENOENT')) throw error })
        }
      }
      return await work(replace)
    } finally {
      active = false
      await lock.close()
      if (!uncertain) {
        const named = await lstat(lockPath)
        if (named.ino !== owner.ino || named.dev !== owner.dev || named.isSymbolicLink()) throw new LocalStoreError('write-uncertain')
        await unlink(lockPath)
        await syncDirectory(base)
      }
    }
  }
  return { base, writer }
}

/** Explicit trusted-host storage adapter. No default path, agent tool or auto-recovery. */
export async function openLocalRecordStore(directory: string, projectId: string,
  options: LocalStoreOptions & { legacyDigestLocale?: string } = {}): Promise<LocalTransactionalRecordPort> {
  const legacyChecksum = createLegacySnapshotChecksum(options.legacyDigestLocale)
  function checksumFor(version: DigestVersion) {
    if (version === legacyDigestVersion) return legacyChecksum
    if (version === currentDigestVersion) return computeSnapshotChecksum
    throw new LocalStoreError('invalid-record')
  }
  const { base, writer } = await area(directory, projectId, options)
  for (const kind of kinds) await safeDirectory(join(base, kind), true)
  function pathFor(kind: string, id: string) {
    if (!kinds.includes(kind)) throw new LocalStoreError('invalid-record')
    if (!localId(id)) throw new LocalStoreError('invalid-id')
    return join(base, kind, `${computeSnapshotChecksum(id)}.json`)
  }
  function decode(text: string, kind: string, id?: string): LocalRecord {
    const value = JSON.parse(text)
    const schemaVersion = value?.schemaVersion
    const legacy = schemaVersion === 'local-record-envelope/v0.1'
    if (!legacy && schemaVersion !== 'local-record-envelope/v0.2') throw new Error()
    const raw = localObject(value, legacy ? ['schemaVersion', 'record', 'checksum']
      : ['schemaVersion', 'digestVersion', 'record', 'checksum'])
    const record = localRecord(raw.record)
    const digestVersion = legacy ? legacyDigestVersion : raw.digestVersion
    if (digestVersion !== legacyDigestVersion && digestVersion !== currentDigestVersion) throw new Error()
    // v0.2 always hashes deterministically and includes the identity contract in the checksum.
    const checksum = legacy ? legacyChecksum(record) : computeSnapshotChecksum({ schemaVersion, digestVersion, record })
    if (raw.checksum !== checksum || record.projectId !== projectId || record.kind !== kind
      || (id !== undefined && record.id !== id)) throw new Error()
    return Object.freeze({ ...record, digestVersion })
  }
  async function read(kind: string, id: string): Promise<LocalRecord | null> {
    const path = pathFor(kind, id)
    await safeDirectory(dirname(path), false)
    const text = await readText(path)
    if (text === null) return null
    try { return decode(text, kind, id) } catch { throw new LocalStoreError('corrupt-record') }
  }
  async function write(value: RecordWrite, expected: number | null, replace: (path: string, text: string) => Promise<void>) {
    const keys = value && Object.hasOwn(value, 'digestVersion') ? [...recordKeys, 'digestVersion'] : recordKeys
    const { digestVersion, ...body } = localObject(value, keys)
    const record = localRecord(body)
    if (record.projectId !== projectId) throw new LocalStoreError('invalid-record')
    const previous = await read(record.kind, record.id)
    if (expected === null) {
      if (previous) throw new LocalStoreError('already-exists')
      if (record.revision !== 1) throw new LocalStoreError('invalid-record')
    } else {
      if (immutableKinds.includes(record.kind)) throw new LocalStoreError('already-exists')
      if (!localRevision(expected) || !previous || previous.revision !== expected
        || !localRevision(expected + 1) || record.revision !== expected + 1) throw new LocalStoreError('stale-revision')
    }
    const version = digestVersion ?? previous?.digestVersion ?? currentDigestVersion
    if ((version !== legacyDigestVersion && version !== currentDigestVersion)
      || (previous && version !== previous.digestVersion)) throw new LocalStoreError('invalid-record')
    const envelope = { schemaVersion: 'local-record-envelope/v0.2', digestVersion: version, record }
    await replace(pathFor(record.kind, record.id), `${JSON.stringify({ ...envelope,
      checksum: computeSnapshotChecksum(envelope) })}\n`)
  }
  async function list(kind: string) {
    pathFor(kind, 'validate-id')
    await safeDirectory(join(base, kind), false)
    const results: LocalRecord[] = []
    for (const name of (await readdir(join(base, kind))).sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const text = await readText(join(base, kind, name))
      try {
        const record = decode(text!, kind)
        if (`${computeSnapshotChecksum(record.id)}.json` !== name) throw new Error()
        results.push(record)
      } catch { throw new LocalStoreError('corrupt-record') }
    }
    return Object.freeze(results)
  }
  return Object.freeze({ checksumFor, read, list,
    create: (record: RecordWrite) => writer((replace) => write(record, null, replace)),
    save: (record: RecordWrite, expectedRevision: number) => writer((replace) => write(record, expectedRevision, replace)),
    exclusive: <T>(work: (port: LocalRecordPort) => Promise<T>) => writer(async (replace) => {
      let active = true
      function check() { if (!active) throw new LocalStoreError('locked') }
      const scoped: LocalRecordPort = Object.freeze({
        checksumFor: (version) => { check(); return checksumFor(version) },
        read: async (kind: string, id: string) => { check(); const result = await read(kind, id); check(); return result },
        list: async (kind: string) => { check(); const result = await list(kind); check(); return result },
        create: async (record: RecordWrite) => { check(); await write(record, null, replace) },
        save: async (record: RecordWrite, expected: number) => { check(); await write(record, expected, replace) },
      })
      try { return await work(scoped) } finally { active = false }
    }),
  })
}

/** Append-only API; full-file atomic replacement keeps partial JSONL tails out of history. */
export async function openLocalAuditPort(directory: string, projectId: string, options: LocalStoreOptions = {}): Promise<LocalAuditPort> {
  const { base, writer } = await area(directory, projectId, options)
  const path = join(base, 'events.jsonl')
  async function read() { await safeDirectory(base, false); return (await readText(path)) ?? '' }
  return Object.freeze({ read, async appendLine(build: (history: string) => string | null) {
    return writer(async (replace) => {
      const history = await read()
      const line = build(history)
      if (line === null) return null
      if (typeof line !== 'string' || !line || /[\r\n]/.test(line)) throw new LocalStoreError('invalid-record')
      await replace(path, `${history}${line}\n`)
      return line
    })
  } })
}
