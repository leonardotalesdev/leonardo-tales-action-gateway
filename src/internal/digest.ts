import { createHash } from 'node:crypto'
import { copyLocalJson, type RecordBody } from './local-record.js'

export const legacyDigestVersion = 'legacy-v0.1'
export const currentDigestVersion = 'utf16-v1'
export type DigestVersion = typeof legacyDigestVersion | typeof currentDigestVersion
export type SnapshotChecksum = (payload: unknown) => string

// Operation input, proposal, scope/definition/policy bindings, approval IDs and
// digests, and execution identities follow the persisted operation version.
// Allowance and attempt evidence carry that same version. Local-record v0.1
// checksums use the legacy hash, and v0.2 checksums always use utf16-v1.
// Manifest equality uses its validated contents. The historical scope ID still
// hashes the manifest with the operation's original contract.
// Scalar project/Task/Run/operation IDs, paths and approval decision IDs keep
// their bytes, as do audit event IDs over flat arrays of primitives. Task/Run
// validation and audit event/chain hashing use their own deterministic codecs.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortJsonValue(value: unknown, compare: (left: string, right: string) => number): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item, compare))
  }

  if (!isRecord(value)) {
    return value
  }

  return Object.fromEntries(
    Object.keys(value).sort(compare).map((key) => [key, sortJsonValue(value[key], compare)]),
  )
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function legacyChecksum(payload: unknown, compare: (left: string, right: string) => number) {
  if (typeof payload === 'undefined') {
    throw new Error('File memory payload is required.')
  }

  const json = JSON.stringify(payload)
  const sorted = sortJsonValue(json === undefined ? null : JSON.parse(json), compare)
  return hashJson(sorted)
}

/**
 * utf16-v1 hashes compact UTF-8 JSON after validating and copying the input.
 * The copy preserves array order, sorts object keys by UTF-16 code units, and
 * normalizes signed zero. JSON.stringify emits array-index keys first in numeric
 * order. Strings retain their original code units.
 */
export function computeSnapshotChecksum(payload: unknown) {
  return hashJson(copyLocalJson(payload))
}

export function computeRecordEnvelopeChecksum(envelope: {
  schemaVersion: string; digestVersion: DigestVersion; record: RecordBody
}) {
  // Count the payload against its existing limits. The envelope adds two
  // object levels and eight nodes (two objects and six metadata fields).
  return hashJson(copyLocalJson(envelope, -2, { nodes: -8 }))
}

/** v0.1.0 used the default Node/ICU localeCompare ordering with stable ties. */
export function createLegacySnapshotChecksum(locale?: string): SnapshotChecksum {
  if (locale !== undefined && (typeof locale !== 'string' || Intl.Collator.supportedLocalesOf(locale).length !== 1)) {
    throw new Error('unsupported-legacy-digest-locale')
  }
  const { compare } = new Intl.Collator(locale)
  return (payload) => legacyChecksum(payload, compare)
}

export function validateExplicitLegacyLocale(locale: string): void {
  const [canonical] = Intl.Collator.supportedLocalesOf(locale, { localeMatcher: 'lookup' })
  const unicodeExtension = /-u((?:-[a-z0-9]{2,8})+)/.exec(locale.toLowerCase())
  // Canonicalization can silently keep just the first value for a repeated key.
  const unicodeKeys = unicodeExtension?.[1].split('-').filter((part) => part.length === 2) ?? []
  const unsupported = 'unsupported-legacy-digest-locale'
  if (!canonical || new Set(unicodeKeys).size !== unicodeKeys.length) throw new Error(unsupported)

  const requested = new Intl.Locale(canonical)
  const [regionalLocale] = Intl.DateTimeFormat.supportedLocalesOf(requested.baseName, { localeMatcher: 'lookup' })
  if (!regionalLocale) throw new Error(unsupported)

  // Date formatting carries regional data even when collation is shared with the parent language.
  const regional = new Intl.Locale(new Intl.DateTimeFormat(regionalLocale).resolvedOptions().locale).maximize()
  if (requested.maximize().baseName !== regional.baseName
    || (requested.script && requested.script !== regional.script)
    || (requested.region && requested.region !== regional.region)) throw new Error(unsupported)

  // Match the legacy digest collator's resolution and require every requested extension to survive.
  const resolved = new Intl.Locale(new Intl.Collator(canonical, { localeMatcher: 'best fit' }).resolvedOptions().locale)
  if (resolved.language !== requested.language
    || canonical.slice(requested.baseName.length) !== resolved.toString().slice(resolved.baseName.length)) {
    throw new Error(unsupported)
  }
}
