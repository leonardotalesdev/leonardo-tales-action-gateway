import { createHash } from 'node:crypto'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeForStableJson(value: unknown): unknown {
  const json = JSON.stringify(value)

  if (typeof json === 'undefined') {
    return null
  }

  return sortJsonValue(JSON.parse(json) as unknown)
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue)
  }

  if (!isRecord(value)) {
    return value
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, item]) => [key, sortJsonValue(item)]),
  )
}

function stableJsonStringify(value: unknown, spacing = 0) {
  return JSON.stringify(normalizeForStableJson(value), null, spacing)
}

export function computeSnapshotChecksum(payload: unknown) {
  if (typeof payload === 'undefined') {
    throw new Error('File memory payload is required.')
  }

  return createHash('sha256').update(stableJsonStringify(payload)).digest('hex')
}
