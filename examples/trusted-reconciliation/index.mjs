import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createActionGateway, createTrustedReconciliationHost } from '@leonardo-tales/action-gateway'

const [, , promote] = process.argv
assert.ok(process.argv.length === 3 && isAbsolute(promote),
  'Pass the absolute path to the installed lt-action-gateway-promote-r2 executable.')

const scratch = await mkdtemp(join(await realpath(tmpdir()), 'action-gateway-reconciliation-'))
const directory = join(scratch, 'task-store')
// The host's evidence lives outside the Gateway store.
const callsPath = join(scratch, 'handler-calls.txt')
const effectPath = join(scratch, 'effect.json')
const dossierPath = join(scratch, 'evidence.json')

const taskId = 'demo-task'
const runId = 'original-run'
const operationKey = 'export-1'
const actionRef = { id: 'demo.export', revision: 1 }
const actorId = 'demo-reconciliation-operator'
const input = { correlationId: randomUUID(), rowIds: [1, 2, 3, 4] }
const executedAt = '2030-01-01T00:00:00.000Z'
const qualifiedAt = '2030-01-01T00:01:00.000Z'
const request = { requestId: 'review-export-1', operationKey, evidenceRef: { id: 'export-dossier', revision: 1 } }

async function saveEvidence(path, value) {
  await writeFile(path, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600, flush: true })
  const parent = await open(scratch, 'r')
  try { await parent.sync() } finally { await parent.close() }
}

async function readEvidence(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

async function handlerCount() {
  return (await readFile(callsPath, 'utf8')).split('\n').filter(Boolean).length
}

function digest(domain, value) {
  return createHash('sha256').update(JSON.stringify([domain, value])).digest('hex')
}

try {
  await mkdir(directory, { mode: 0o700 })
  let approved
  const gateway = await createActionGateway({
    directory,
    task: { id: taskId, cap: 10, unit: 'rows', expiresAt: '2030-01-01T01:00:00.000Z' },
    approverId: 'demo-approver',
    now: () => executedAt,
    // A fixed reviewer approves only this exact synthetic export.
    async review(review) {
      if (review.taskId !== taskId || review.runId !== runId || review.operationKey !== operationKey
        || review.action !== actionRef.id || review.amount !== 4 || review.unit !== 'rows'
        || review.input.correlationId !== input.correlationId
        || !isDeepStrictEqual(review.input.rowIds, input.rowIds)) return 'DENIED'
      approved = review
      return 'APPROVED'
    },
    tool: {
      ...actionRef,
      amount: ({ rowIds }) => rowIds.length,
      async execute({ correlationId, rowIds }) {
        await appendFile(callsPath, correlationId + '\n', { mode: 0o600, flush: true })
        // This independent record is the synthetic effect. The acknowledgement is lost.
        await saveEvidence(effectPath, { kind: 'rows-exported', correlationId, rowIds })
        return { outcome: 'unknown' }
      },
    },
  })

  assert.equal((await gateway.execute({ runId, operationKey, input })).decision, 'UNKNOWN')
  const original = await gateway.inspect(operationKey)
  assert.ok(original && approved)
  assert.equal(original.decision, 'UNKNOWN')
  assert.equal(original.reason, 'reconciliation-required')
  assert.deepEqual([original.held, original.settled, original.remaining], [4, 0, 6])
  const originalCalls = await handlerCount()
  assert.equal(originalCalls, 1)
  console.log('original', original.decision, 'held', original.held, 'remaining', original.remaining, 'handler_calls', originalCalls)
  await saveEvidence(dossierPath, { actorId, request, approved, original, qualifiedAt })

  // This script has no other workers or admission route. The only handler and all
  // operations above have finished. Establish quiescence externally for a real store.
  const generation = execFileSync(promote, ['--directory', directory, '--task-id', taskId], { encoding: 'utf8' })
  assert.match(generation, /^[a-f0-9]{64}\n$/)

  // The application authenticates and authorizes this fixed actor. Keep the
  // controller, evidence access and policy outside any agent-facing tool wrapper.
  const controller = await createTrustedReconciliationHost({
    directory,
    taskId,
    host: {
      actorId,
      now: () => qualifiedAt,
      async resolveEvidence({ requestId, actorId, evidenceRef, subject }, signal) {
        const dossier = await readEvidence(dossierPath)
        if (signal.aborted || !dossier || dossier.actorId !== actorId || dossier.request?.requestId !== requestId
          || !isDeepStrictEqual(dossier.request.evidenceRef, evidenceRef)) return { status: 'unresolved' }

        const { approved: approval, original: observed } = dossier
        if (!approval?.input || !observed || subject.observedPrefix !== 'reconciliation-required'
          || subject.originalTaskId !== approval.taskId || subject.originalRunId !== approval.runId
          || subject.operationKey !== approval.operationKey || subject.operationKey !== dossier.request.operationKey
          || subject.actionRef.id !== approval.action || subject.actionRef.revision !== actionRef.revision
          || subject.target.kind !== 'logical-operation' || subject.target.resource !== approval.operationKey
          || subject.amount !== approval.amount || subject.unit !== approval.unit
          || subject.approvalRequestId !== approval.requestId || subject.approvalRequestId !== observed.approvalRequestId
          || subject.approvalRequestDigest !== approval.requestDigest
          || subject.inputDigest !== observed.inputDigest || subject.proposalDigest !== observed.proposalDigest) {
          return { status: 'unresolved' }
        }

        // The selector locates the dossier. Only the matching effect record proves occurrence here.
        const effect = await readEvidence(effectPath)
        const expected = { kind: 'rows-exported', correlationId: approval.input.correlationId, rowIds: approval.input.rowIds }
        if (signal.aborted || !isDeepStrictEqual(effect, expected)) return { status: 'unresolved' }
        const { subjectDigest, expectedState } = subject
        return {
          status: 'confirmed-effect',
          binding: { requestId, actorId, evidenceRef, subjectDigest, expectedState },
          evidenceDigest: digest('demo-dossier', { dossier, effect }),
          effectOccurredDigest: digest('demo-effect-occurred', effect),
          qualifiedAt: dossier.qualifiedAt,
        }
      },
    },
  })
  const applied = await controller.reconcile(request)
  assert.deepEqual(applied, { status: 'applied', ...request, outcome: 'reconciled-effect' })
  const settled = await gateway.inspect(operationKey)
  assert.ok(settled)
  assert.equal(settled.decision, 'EXECUTED')
  assert.equal(settled.reason, 'reconciled-effect')
  assert.deepEqual([settled.held, settled.settled, settled.remaining], [0, 4, 6])
  assert.equal(await handlerCount(), 1)
  console.log('reconciliation', applied.status, applied.outcome, 'settled', settled.settled, 'remaining', settled.remaining)

  let clockCalls = 0
  let resolverCalls = 0
  const reopened = await createTrustedReconciliationHost({
    directory,
    taskId,
    host: {
      actorId,
      now() { clockCalls++; assert.fail('Applied replay must skip the trusted clock') },
      async resolveEvidence() { resolverCalls++; assert.fail('Applied replay must skip evidence resolution') },
    },
  })
  // Replay the reconciliation request only. The business operation stays closed.
  const replay = await reopened.reconcile(request)
  assert.deepEqual(replay, { ...applied, status: 'replayed' })
  assert.deepEqual(await gateway.inspect(operationKey), settled)
  const finalCalls = await handlerCount()
  assert.deepEqual([resolverCalls, clockCalls, finalCalls], [0, 0, 1])
  console.log('replay', replay.status, 'resolver_calls', resolverCalls, 'clock_calls', clockCalls, 'handler_calls', finalCalls)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
