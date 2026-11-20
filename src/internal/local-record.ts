import { types } from 'node:util'

export type LocalStoreErrorCode = 'invalid-record' | 'invalid-id' | 'unsafe-path' | 'locked'
  | 'already-exists' | 'stale-revision' | 'corrupt-record' | 'write-uncertain' | 'io-error'
export class LocalStoreError extends Error {
  readonly code: LocalStoreErrorCode
  constructor(code: LocalStoreErrorCode) { super(code); this.code = code }
}
export type RecordBody = Readonly<{
  kind: string; id: string; projectId: string; revision: number; payload: unknown
}>
export const maxBytes = 16 * 1024 * 1024

export function rejectLocalProxy(value: unknown): void {
  if (types.isProxy(value)) throw new LocalStoreError('invalid-record')
}

/** Strict JSON boundary before hashing or writing a record. */
export function copyLocalJson(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (++budget.nodes > 100_000 || depth > 32) throw new LocalStoreError('invalid-record')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string' && value.length <= maxBytes) return value
  // Match the persisted JSON number before a caller can hash or meter the copy.
  if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value
  if (typeof value !== 'object') throw new LocalStoreError('invalid-record')
  rejectLocalProxy(value)
  const prototype = Object.getPrototypeOf(value)
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || value.length > 50_000
      || Reflect.ownKeys(value).length !== value.length + 1) throw new LocalStoreError('invalid-record')
    const result: unknown[] = []
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
      if (!descriptor || !('value' in descriptor)) throw new LocalStoreError('invalid-record')
      result.push(copyLocalJson(descriptor.value, depth + 1, budget))
    }
    return Object.freeze(result)
  }
  if (prototype !== Object.prototype && prototype !== null) {
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
