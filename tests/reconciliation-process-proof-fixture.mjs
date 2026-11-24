import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { lstat, mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createActionGateway } from '../dist/index.js'
import { readExecutionAudit } from '../dist/internal/execution-audit.js'
import { qualificationDigest, reconciliationDecisionId, reconciliationEventId } from '../dist/internal/reconciliation-record.js'
import { promoteTaskStore } from '../dist/internal/store-promotion.js'
import { config, first, projectDirectory, records, second } from './fixture.mjs'
import { auditPath, decisionRows, makeQualification, readSubject } from './reconciliation-decision-fixture.mjs'

export const proofTimeout = 60_000
const phaseTimeout = 10_000
const controllerWorker = new URL('./reconciliation-process-proof-worker.mjs', import.meta.url)

export const proofRequest = {
  requestId: 'recovery-request-' + first.operationKey,
  operationKey: first.operationKey,
  evidenceRef: { id: 'qualified-evidence-' + first.operationKey, revision: 1 },
}

export async function writerPath(root, area = 'state') {
  return join(await projectDirectory(root, area), '.writer.lock')
}

async function diagnostics(root) {
  const locks = {}
  for (const area of ['state', 'audit']) {
    try {
      const lock = await lstat(await writerPath(root, area))
      locks[area] = { mode: lock.mode & 0o777, inode: lock.ino }
    } catch (error) { locks[area] = error.code ?? error.message }
  }
  const rows = await decisionRows(root).catch((error) => [{ error: error.message }])
  const audit = await auditPath(root).then((path) => readFile(path, 'utf8')).catch(() => '')
  return {
    locks,
    rows: rows.map(({ envelope, error }) => error ?? {
      id: envelope.record.id, revision: envelope.record.revision, phase: envelope.record.payload.phase,
    }),
    qualificationEvents: audit.split('\n').filter((line) => line.includes('reconciliation-decision-qualified')).length,
  }
}

export async function proofScope(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'gateway-r5-'))
  const root = join(workspace, 'store')
  const entryLog = join(workspace, 'handler.jsonl')
  const children = []
  let cleanup
  function close() {
    cleanup ??= (async () => {
      const stops = await Promise.allSettled(children.map((worker) => worker.stop()))
      const failures = stops.filter(({ status }) => status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(({ reason }) => reason), 'Could not reap proof workers')
      await rm(workspace, { recursive: true, force: true })
    })()
    return cleanup
  }
  t.after(close)
  await mkdir(root, { mode: 0o700 })

  async function fail(phase, cause) {
    const summary = children.map((worker) => worker.trace())
    throw new Error(JSON.stringify({ scenario: t.name, phase, children: summary, ...await diagnostics(root) }), { cause })
  }

  function spawn(url, args = [], options = {}) {
    assert.ok(!cleanup, 'proof scope already closed')
    const child = fork(url, args, {
      stdio: ['pipe', 'ignore', 'pipe', 'ipc'], execArgv: [], ...options,
      env: { ...process.env, NODE_OPTIONS: '', ...options.env },
    })
    const updates = new EventEmitter()
    const messages = []
    const phases = []
    let exit
    let childError
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (data) => { stderr = (stderr + data).slice(-8000) })
    child.stdin?.on('error', (error) => { childError = error; updates.emit('update') })
    child.on('error', (error) => { childError = error; updates.emit('update') })
    child.on('message', (message) => {
      messages.push(message)
      phases.push(message.type === 'result' ? message : {
        type: message.type, epoch: message.epoch, clockCalls: message.clockCalls,
      })
      updates.emit('update')
    })
    child.once('close', (code, signal) => {
      exit = { code, signal }
      updates.emit('update')
    })

    async function wait(phase, check, requireRunning = false) {
      const signal = AbortSignal.timeout(phaseTimeout)
      for (;;) {
        const result = check()
        if (result !== undefined) return result
        if (requireRunning && (childError || exit)) return fail(phase, childError)
        try { await once(updates, 'update', { signal }) }
        catch (error) { return fail(phase, error) }
      }
    }

    async function waitExit() { return wait('child exit', () => exit) }
    const worker = {
      pid: child.pid,
      trace: () => ({ pid: child.pid, phases, exit, stderr, error: childError?.message }),
      send(message) {
        assert.ok(child.connected, 'child IPC closed before command')
        child.send(message, (error) => {
          if (error) { childError = error; updates.emit('update') }
        })
      },
      next(...types) {
        return wait(types.join(' or '), () => {
          const index = messages.findIndex(({ type }) => types.includes(type))
          if (index >= 0) return messages.splice(index, 1)[0]
        }, true)
      },
      releaseWriter() { child.stdin.write(Buffer.from([1])) },
      waitExit,
      async result(message) {
        const { type, ...result } = message ?? await worker.next('result')
        assert.equal(type, 'result')
        assert.deepEqual(await waitExit(), { code: 0, signal: null })
        return result
      },
      async kill() {
        assert.equal(child.kill('SIGKILL'), true)
        assert.deepEqual(await waitExit(), { code: null, signal: 'SIGKILL' })
      },
      async stop() {
        if (exit) return
        child.kill('SIGKILL')
        await waitExit()
      },
    }
    children.push(worker)
    return worker
  }

  async function start(options = {}) {
    const { ambient, ...controllerOptions } = options
    const env = ambient ? { LANG: ambient, LC_ALL: ambient } : {}
    const worker = spawn(controllerWorker, [root, JSON.stringify(controllerOptions)], { env })
    const opening = await worker.next('ready', 'result')
    if (opening.type === 'ready') worker.ready = opening
    else worker.openingReceipt = await worker.result(opening)
    return worker
  }

  return { root, entryLog, start, spawn, close }
}

export async function recordEntry(entryLog, operationKey, attemptId) {
  assert.equal(typeof attemptId, 'string', 'handler entry must identify the actual attempt')
  const file = await open(entryLog, 'a', 0o600)
  try {
    await file.writeFile(JSON.stringify({ operationKey, attemptId }) + '\n')
    await file.sync()
  } finally { await file.close() }
}

export function proofConfig(scope, outcome = 'unknown', operations = [first, second]) {
  const options = config(scope.root)
  options.tool.execute = async (input) => {
    const operation = operations.find(({ input: fixture }) => fixture.batch === input.batch)
    assert.ok(operation, 'handler received an unexpected fixture operation')
    const row = (await records(scope.root, 'action-allowance')).find(
      ({ envelope }) => envelope.record.payload.key === operation.operationKey)
    await recordEntry(scope.entryLog, operation.operationKey, row?.envelope.record.payload.binding?.executionId)
    return outcome === 'unknown' ? { outcome } : { outcome, evidenceId: 'proof-' + input.batch }
  }
  return options
}

export async function assertEntries(scope, operations) {
  const rows = await records(scope.root, 'action-allowance')
  const expected = operations.map(({ operationKey }) => {
    const row = rows.find(({ envelope }) => envelope.record.payload.key === operationKey)
    const attemptId = row?.envelope.record.payload.binding?.executionId
    assert.equal(typeof attemptId, 'string', operationKey)
    return { operationKey, attemptId }
  })
  const actual = (await readFile(scope.entryLog, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(actual, expected)
}

export async function prepareAmbiguous(scope) {
  const options = proofConfig(scope)
  const gateway = await createActionGateway(options)
  const receipt = await gateway.execute(first)
  assert.equal(receipt.decision, 'UNKNOWN')
  const generation = await promoteTaskStore(scope.root, options.task.id)
  const subject = await readSubject(scope.root)
  assert.equal(subject.observedPrefix, 'reconciliation-required')
  const qualification = makeQualification(subject, generation)
  return { gateway, options, receipt, generation, subject, qualification }
}

export async function assertDecision(root, { revision, qualification, eventCount }) {
  const rows = await decisionRows(root)
  assert.equal(rows.length, revision === 0 ? 0 : 1)
  const allowanceRows = (await records(root, 'action-allowance')).map(({ envelope }) => envelope.record)
  const manifest = allowanceRows.find(({ id }) => id === 'task-allowance')
  assert.equal(manifest.revision, 2)
  const history = readExecutionAudit(await readFile(await auditPath(root), 'utf8'), manifest.projectId)
  const events = history.filter(({ event }) => event.type === 'reconciliation-decision-qualified')
  assert.equal(events.length, eventCount)
  if (revision === 0) return
  const { record } = rows[0].envelope
  const id = reconciliationDecisionId(qualification)
  const checksum = qualificationDigest(qualification)
  assert.equal(record.revision, revision)
  assert.equal(record.id, id)
  assert.equal(record.projectId, qualification.projectId)
  assert.equal(manifest.payload.storeGeneration, qualification.storeGeneration)
  assert.equal(record.payload.phase, revision === 1 ? 'qualified' : 'applied')
  if (revision === 1) assert.equal(record.payload.appliedAt, null)
  else assert.ok(record.payload.appliedAt >= qualification.qualifiedAt)
  assert.deepEqual(record.payload.qualification, qualification)
  assert.equal(record.payload.qualificationDigest, checksum)
  const operation = allowanceRows.find(({ payload }) => payload.key === qualification.operationKey)
  const { executionId, runId } = operation.payload.binding
  assert.equal(executionId, qualification.attemptId)
  assert.equal(operation.payload.binding.executionIdentity, qualification.executionIdentity)
  assert.equal(operation.payload.phase, 'held')
  const [[run], [attempt], [execution]] = await Promise.all([
    ['runs', runId], ['gateway-attempts', executionId], ['execution', executionId],
  ].map(async ([kind, recordId]) => (await records(root, kind)).map(({ envelope }) => envelope.record)
    .filter(({ id }) => id === recordId)))
  assert.equal(run.revision, record.payload.runRevisionAtQualification)
  assert.equal(run.payload.status, 'blocked')
  assert.partialDeepStrictEqual(attempt.payload, { phase: 'reconciliation-required', result: null })
  assert.equal(execution.payload.status, 'execution_unknown')
  if (eventCount) {
    assert.partialDeepStrictEqual(events[0].event, {
      id: reconciliationEventId(id), projectId: qualification.projectId, taskId: qualification.taskId, runId,
      actorId: qualification.actorId, occurredAt: qualification.qualifiedAt,
      observationCode: qualification.outcome + ':' + checksum,
      subjectRef: { kind: 'artifact', id, revision: 1 },
    })
  }
}

export async function allowance(gateway, key = first.operationKey) {
  const { cap, held, settled, remaining } = await gateway.inspect(key)
  assert.equal(remaining, cap - held - settled, 'allowance must conserve capacity')
  return [held, settled, remaining]
}

export async function assertOnlyDecisionAndEventChanged(root, before, after) {
  const [row] = await decisionRows(root)
  const decision = relative(root, row.path)
  const audit = relative(root, await auditPath(root))
  assert.deepEqual(Object.keys(after).sort(), [...new Set([...Object.keys(before), decision])].sort())
  for (const [path, contents] of Object.entries(before)) {
    if (path === audit) assert.deepEqual(after[path].subarray(0, contents.length), contents)
    else if (path !== decision) assert.deepEqual(after[path], contents, path)
  }
  assert.ok(after[audit].length > before[audit].length)
  assert.notDeepEqual(after[decision], before[decision])
}
