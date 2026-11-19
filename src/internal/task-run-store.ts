import { createTask, createRun, transitionRun, type Task, type Run, type RunEvent } from './task-run.js'

/** Replaceable storage port; only the host adapter knows filesystem paths. */
export type StateRecord = Readonly<{ kind: string; id: string; projectId: string; revision: number; payload: unknown }>
export type TaskRunStoragePort = Readonly<{
  read(kind: string, id: string): Promise<StateRecord | null>
  list(kind: string): Promise<readonly StateRecord[]>
  create(record: StateRecord): Promise<void>
  save(record: StateRecord, expectedRevision: number): Promise<void>
}>
export class TaskRunStorageError extends Error {
  readonly code: 'invalid-state' | 'missing-task' | 'stale-revision'
  constructor(code: TaskRunStorageError['code']) { super(code); this.code = code }
}
export type StoredTask = Readonly<{ revision: number; task: Task }>

function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new TaskRunStorageError('invalid-state')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (value.length > 50_000 || Reflect.ownKeys(value).length !== value.length + 1) throw new TaskRunStorageError('invalid-state')
    const items: string[] = []
    for (let index = 0; index < value.length; index++) {
      const field = Object.getOwnPropertyDescriptor(value, String(index))
      if (!field || !('value' in field)) throw new TaskRunStorageError('invalid-state')
      items.push(canonical(field.value, depth + 1))
    }
    return `[${items.join(',')}]`
  }
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TaskRunStorageError('invalid-state')
  }
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string')) throw new TaskRunStorageError('invalid-state')
  return `{${(keys as string[]).sort().map((key) => {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field || !('value' in field)) throw new TaskRunStorageError('invalid-state')
    return `${JSON.stringify(key)}:${canonical(field.value, depth + 1)}`
  }).join(',')}}`
}
export function restoreTask(value: unknown): Task {
  try {
    const raw = value as Task
    const original = canonical(raw)
    const task = createTask(raw)
    if (!task.ok || original !== canonical(task.value)) throw new Error()
    return task.value
  } catch { throw new TaskRunStorageError('invalid-state') }
}
/** Replay validated M1 receipts; a checksum alone cannot establish domain validity. */
export function restoreRun(task: Task, value: unknown): Run {
  try {
    const raw = value as Run
    const original = canonical(raw)
    if (!raw || raw.schemaVersion !== 'run/v0.1' || raw.taskId !== task.id || raw.projectId !== task.projectId
      || !Array.isArray(raw.appliedEvents) || raw.appliedEvents.length > 10_000) throw new Error()
    const created = createRun(task, { id: raw.id, createdAt: raw.createdAt,
      agentDefinitionRef: raw.agentDefinitionRef, maxSteps: raw.maxSteps })
    if (!created.ok) throw new Error()
    let run = created.value
    for (const event of raw.appliedEvents) {
      const next = transitionRun(task, run, event as RunEvent)
      if (next.status !== 'applied') throw new Error()
      run = next.run
    }
    if (canonical(run) !== original) throw new Error()
    return run
  } catch { throw new TaskRunStorageError('invalid-state') }
}

/** Workflow persistence only: no proposals, approval evidence or execution authority are loaded here. */
export function createTaskRunStore(port: TaskRunStoragePort, projectId: Task['projectId']) {
  function owner(task: Task) {
    if (task.projectId !== projectId) throw new TaskRunStorageError('invalid-state')
  }
  async function loadTask(id: Task['id']): Promise<StoredTask | null> {
    const record = await port.read('tasks', id)
    if (!record) return null
    const task = restoreTask(record.payload)
    owner(task)
    if (record.kind !== 'tasks' || record.id !== task.id || record.projectId !== projectId
      || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new TaskRunStorageError('invalid-state')
    return Object.freeze({ task, revision: record.revision })
  }
  async function loadRun(id: Run['id']): Promise<Run | null> {
    const record = await port.read('runs', id)
    if (!record) return null
    const taskId = (record.payload as Run)?.taskId
    const task = await loadTask(taskId)
    if (!task) throw new TaskRunStorageError('missing-task')
    const run = restoreRun(task.task, record.payload)
    if (record.kind !== 'runs' || record.id !== run.id || record.projectId !== projectId
      || record.revision !== run.revision) throw new TaskRunStorageError('invalid-state')
    return run
  }
  return Object.freeze({ loadTask, loadRun,
    async createTask(value: Task): Promise<StoredTask> {
      const task = restoreTask(value)
      owner(task)
      await port.create({ kind: 'tasks', id: task.id, projectId, revision: 1, payload: task })
      return Object.freeze({ task, revision: 1 })
    },
    async saveTask(value: Task, expectedRevision: number): Promise<StoredTask> {
      const task = restoreTask(value)
      owner(task)
      const previous = await loadTask(task.id)
      if (!previous || previous.revision !== expectedRevision) throw new TaskRunStorageError('stale-revision')
      if (previous.task.createdAt !== task.createdAt) throw new TaskRunStorageError('invalid-state')
      const revision = expectedRevision + 1
      await port.save({ kind: 'tasks', id: task.id, projectId, revision, payload: task }, expectedRevision)
      return Object.freeze({ task, revision })
    },
    async createRun(value: Run): Promise<Run> {
      const task = await loadTask(value.taskId)
      if (!task) throw new TaskRunStorageError('missing-task')
      const run = restoreRun(task.task, value)
      if (run.revision !== 1 || run.status !== 'created') throw new TaskRunStorageError('invalid-state')
      await port.create({ kind: 'runs', id: run.id, projectId, revision: 1, payload: run })
      return run
    },
    async saveRun(value: Run, expectedRevision: number): Promise<Run> {
      const previous = await loadRun(value.id)
      if (!previous || previous.revision !== expectedRevision) throw new TaskRunStorageError('stale-revision')
      const task = await loadTask(previous.taskId)
      if (!task) throw new TaskRunStorageError('missing-task')
      const run = restoreRun(task.task, value)
      // Accept exactly one M1 transition, preserving immutable run settings and receipt history.
      const event = run.appliedEvents.at(-1)
      if (!event || run.revision !== expectedRevision + 1) throw new TaskRunStorageError('invalid-state')
      const next = transitionRun(task.task, previous, event)
      if (next.status !== 'applied' || canonical(next.run) !== canonical(run)) throw new TaskRunStorageError('invalid-state')
      await port.save({ kind: 'runs', id: run.id, projectId, revision: run.revision, payload: run }, expectedRevision)
      return run
    },
    async listRuns(taskId: Task['id']): Promise<readonly Run[]> {
      if (!await loadTask(taskId)) throw new TaskRunStorageError('missing-task')
      const runs: Run[] = []
      for (const record of await port.list('runs')) {
        const run = await loadRun(record.id as Run['id'])
        if (!run) throw new TaskRunStorageError('invalid-state')
        if (run.taskId === taskId) runs.push(run)
      }
      return Object.freeze(runs)
    },
  })
}
