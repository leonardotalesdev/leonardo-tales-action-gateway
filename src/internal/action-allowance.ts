import { computeSnapshotChecksum as digest, type DigestVersion } from './digest.js'
import { projectManifest } from './store-manifest.js'
import { readClosedExecution } from './execution-gateway.js'
import type { ExactActionBinding } from './gateway-contract.js'
import { actionAllowanceKind as kind, localId, localObject, localRevision, localTimestamp, taskManifestId as manifestId,
  type LocalRecord, type LocalRecordPort } from './local-store.js'

type AllowanceReadPort = Pick<LocalRecordPort, 'read' | 'list' | 'checksumFor'>

export type RefusalBalance = Readonly<{
  reason: 'task_limit'; cap: number; settled: number; held: number; remaining: number
}>

export type Operation = Readonly<{
  digestVersion: DigestVersion
  key: string
  runId: string
  runRevision: number
  createdAt: string
  inputDigest: string
  proposalDigest: string
  amount: number
  phase: 'pending' | 'held' | 'blocked'
  binding: ExactActionBinding | null
  refusalBasis?: RefusalBalance
}>

export function operationId(key: string) { return `operation-${digest(key)}` }
export function nativeRunId(id: string): `run-${string}` { return `run-${digest(id)}` }
export function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function createTaskAllowance(projectId: string, taskId: string, cap: number, manifest: object) {
  async function verifyManifest(port: LocalRecordPort, mode: 'existing' | 'initialize' | 'inspect' = 'existing') {
    const record = await port.read(kind, manifestId)
    if (!record) {
      if (mode === 'existing' || (await port.list(kind)).length) throw new Error('missing-task-allowance')
      if (mode === 'initialize') await port.create({ kind, projectId, id: manifestId, revision: 1, payload: manifest })
      return
    }
    const { configuration } = projectManifest(record, projectId, port.checksumFor)
    if (digest(configuration) !== digest(manifest)) throw new Error('task-configuration-conflict')
  }

  function parse(record: LocalRecord) {
    const fields = ['key', 'runId', 'runRevision', 'createdAt', 'inputDigest', 'proposalDigest', 'amount', 'phase', 'binding']
    // Earlier blocked operations did not record a decision-time balance.
    if (record.payload && typeof record.payload === 'object' && Object.hasOwn(record.payload, 'refusalBasis')) fields.push('refusalBasis')
    const raw = localObject(record.payload, fields)
    const value = { ...raw, digestVersion: record.digestVersion } as unknown as Operation
    const binding = value.binding
    if (!localId(value.key) || record.id !== operationId(value.key) || !localId(value.runId)
      || !localRevision(value.runRevision) || !localTimestamp(value.createdAt) || !positiveInteger(value.amount)
      || ![value.inputDigest, value.proposalDigest].every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
      || (value.phase === 'pending' ? record.revision !== 1 || binding !== null
        : !['held', 'blocked'].includes(value.phase) || record.revision !== 2 || !binding
          || binding.projectId !== projectId || binding.taskId !== taskId || binding.runId !== nativeRunId(value.runId)
          || binding.baseRunRevision !== value.runRevision || binding.proposalRef?.id !== record.id
          || binding.proposalDigest !== value.proposalDigest)) throw new Error('invalid-task-operation')
    if (value.refusalBasis !== undefined) {
      const basis = value.refusalBasis
      localObject(basis, ['reason', 'cap', 'settled', 'held', 'remaining'])
      if (value.phase !== 'blocked' || basis.reason !== 'task_limit' || basis.cap !== cap
        || ![basis.settled, basis.held, basis.remaining].every((n) => Number.isSafeInteger(n) && n >= 0)
        || basis.remaining !== cap - basis.settled - basis.held || value.amount <= basis.remaining) throw new Error('invalid-refusal-basis')
    }
    return value
  }

  async function read(port: LocalRecordPort, key: string) {
    const row = await port.read(kind, operationId(key))
    if (!row) return null
    const value = parse(row)
    if (value.key !== key) throw new Error('invalid-task-operation')
    return value
  }

  function register(port: LocalRecordPort, { digestVersion, ...value }: Operation) {
    return port.create({ kind, projectId, id: operationId(value.key), revision: 1, payload: value, digestVersion })
  }

  async function outcome(port: AllowanceReadPort, value: Operation) {
    return value.phase === 'held' ? await readClosedExecution(port, value.binding!, value.digestVersion) : null
  }

  async function snapshot(port: AllowanceReadPort, key?: string) {
    let remaining = cap
    let settled = 0
    let held = 0
    let selected: { value: Operation; result: Awaited<ReturnType<typeof outcome>> } | undefined
    for (const row of await port.list(kind)) {
      if (row.id === manifestId) continue
      const value = parse(row)
      const result = await outcome(port, value)
      if (value.key === key) selected = { value, result }
      if (value.phase !== 'held') continue
      if (result?.status === 'confirmed-failure' && result.effect === 'not-performed') continue
      if (value.amount > remaining) throw new Error('task-allowance-inconsistent')
      remaining -= value.amount
      if (result?.status === 'confirmed-success') settled += value.amount
      else held += value.amount
    }
    return { totals: { cap, settled, held, remaining }, selected }
  }

  async function reserve(port: LocalRecordPort, key: string, binding: ExactActionBinding, version: DigestVersion) {
    await verifyManifest(port)
    const value = await read(port, key)
    if (!value || value.digestVersion !== version || value.proposalDigest !== binding.proposalDigest
      || operationId(key) !== binding.proposalRef.id
      || binding.runId !== nativeRunId(value.runId) || binding.projectId !== projectId || binding.taskId !== taskId) {
      throw new Error('reservation-binding-conflict')
    }
    // A prior hold can exist even if the gateway crashed before creating its attempt record.
    if (value.phase !== 'pending') return false
    const { totals } = await snapshot(port)
    const admitted = value.amount <= totals.remaining
    const decision = admitted ? { phase: 'held' } : { phase: 'blocked', refusalBasis: { reason: 'task_limit', ...totals } }
    const { digestVersion, ...payload } = value
    await port.save({ kind, projectId, id: operationId(key), revision: 2, digestVersion,
      payload: { ...payload, binding, ...decision } }, 1)
    return admitted
  }

  return { verifyManifest, read, register, snapshot, reserve, parseOperation: parse }
}
