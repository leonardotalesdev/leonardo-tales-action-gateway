import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createActionGateway } from '@leonardo-tales/action-gateway'
import { config, first, persistedFiles, projectDirectory, records, second, workspace } from './fixture.mjs'

test('timeout aborts the signal and retains capacity even when the handler later reports success', { timeout: 15_000 }, async (t) => {
  const directory = await workspace(t)
  const options = config(directory)
  options.timeoutMs = 25
  const applyEffect = options.tool.execute
  const finish = Promise.withResolvers()
  const completed = Promise.withResolvers()
  let invocations = 0
  let handlerSignal
  let startedAborted
  let abortEvents = 0
  options.tool.execute = async (input, signal) => {
    invocations++
    handlerSignal = signal
    startedAborted = signal.aborted
    signal.addEventListener('abort', () => { abortEvents++ }, { once: true })
    await finish.promise
    const result = await applyEffect(input)
    completed.resolve(result)
    return result
  }

  const gateway = await createActionGateway(options)
  const timedOut = await gateway.execute(first)
  assert.partialDeepStrictEqual(timedOut, {
    decision: 'UNKNOWN', reason: 'reconciliation-required', replayed: false,
    cap: 10, settled: 0, held: 4, remaining: 6, evidenceId: null,
  })
  assert.equal(invocations, 1)
  assert.ok(handlerSignal instanceof AbortSignal)
  assert.equal(startedAborted, false)
  assert.equal(handlerSignal.aborted, true)
  assert.equal(abortEvents, 1)
  const effectPath = join(directory, 'effects')
  await assert.rejects(readFile(effectPath), { code: 'ENOENT' })

  const [attempt] = await records(directory, 'gateway-attempts')
  const [execution] = await records(directory, 'execution')
  const [run] = await records(directory, 'runs')
  const allowance = (await records(directory, 'action-allowance')).find(({ envelope }) =>
    envelope.record.payload.key === first.operationKey)
  assert.partialDeepStrictEqual(attempt.envelope.record, {
    revision: 3, payload: { phase: 'reconciliation-required', result: null },
  })
  assert.deepEqual(attempt.envelope.record.payload.pendingEvents, [])
  assert.partialDeepStrictEqual(execution.envelope.record, { revision: 3, payload: { status: 'execution_unknown' } })
  assert.equal(run.envelope.record.payload.status, 'blocked')
  assert.partialDeepStrictEqual(allowance.envelope.record, { revision: 2, payload: { phase: 'held', amount: 4 } })
  const auditPath = join(await projectDirectory(directory, 'audit'), 'events.jsonl')
  const audit = (await readFile(auditPath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line).event)
  assert.partialDeepStrictEqual(audit.at(-1), { type: 'execution-result-recorded', observationCode: 'execution-unknown' })
  const before = await persistedFiles(directory)
  const replay = { ...first, runId: 'retry-before-completion' }
  assert.deepEqual(await gateway.execute(replay), { ...timedOut, replayed: true })

  finish.resolve()
  assert.deepEqual(await completed.promise, { outcome: 'executed', evidenceId: 'effect-a' })
  assert.equal(await readFile(effectPath, 'utf8'), '4\n')

  assert.deepEqual(await gateway.inspect(first.operationKey), timedOut)
  const reopened = await createActionGateway(options)
  assert.deepEqual(await reopened.inspect(first.operationKey), timedOut)
  assert.deepEqual(await reopened.execute({ ...first, runId: 'retry-after-completion' }), { ...timedOut, replayed: true })
  assert.equal(invocations, 1)
  assert.deepEqual(await persistedFiles(directory), { ...before, effects: Buffer.from('4\n') })
})

test('a cooperative handler sees abort at the configured timeout and its later no-effect result leaves the hold intact', { timeout: 15_000 }, async (t) => {
  const directory = await workspace(t)
  const options = config(directory)
  options.timeoutMs = 125
  const started = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const completed = Promise.withResolvers()
  let invocations = 0
  let abortEvents = 0
  options.tool.execute = async (_input, signal) => {
    invocations++
    const abort = once(signal, 'abort')
    started.resolve(signal)
    await abort
    abortEvents++
    await finish.promise
    completed.resolve()
    return { outcome: 'no-effect', evidenceId: 'cooperative-stop' }
  }
  const gateway = await createActionGateway(options)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const execution = gateway.execute(first)
  const signal = await started.promise
  assert.equal(signal.aborted, false)
  t.mock.timers.tick(options.timeoutMs - 1)
  assert.equal(signal.aborted, false)
  t.mock.timers.tick(1)
  assert.equal(signal.aborted, true)

  const timedOut = await execution
  assert.partialDeepStrictEqual(timedOut, {
    decision: 'UNKNOWN', reason: 'reconciliation-required', evidenceId: null,
    cap: 10, settled: 0, held: 4, remaining: 6,
  })
  const before = await persistedFiles(directory)
  finish.resolve()
  await completed.promise
  const reopened = await createActionGateway(options)
  assert.deepEqual(await reopened.inspect(first.operationKey), timedOut)
  assert.deepEqual(await reopened.execute({ ...first, runId: 'retry-after-cooperative-stop' }), { ...timedOut, replayed: true })
  assert.equal(invocations, 1)
  assert.equal(abortEvents, 1)
  await assert.rejects(readFile(join(directory, 'effects')), { code: 'ENOENT' })
  assert.deepEqual(await persistedFiles(directory), before)
})

test('a confirmed no-effect result releases capacity while a timed-out operation remains held', { timeout: 15_000 }, async (t) => {
  const directory = await workspace(t)
  const options = config(directory)
  options.timeoutMs = 25
  const invocations = []
  options.tool.execute = async (input, signal) => {
    invocations.push({ batch: input.batch, signal })
    if (input.batch === 'a') await once(signal, 'abort')
    return { outcome: 'no-effect', evidenceId: 'verified-empty-export' }
  }
  const gateway = await createActionGateway(options)
  assert.partialDeepStrictEqual(await gateway.execute(first), { decision: 'UNKNOWN', held: 4, remaining: 6 })
  const noEffect = await gateway.execute(second)
  assert.partialDeepStrictEqual(noEffect, {
    decision: 'BLOCKED', reason: 'confirmed-no-effect', evidenceId: 'verified-empty-export',
    held: 4, settled: 0, remaining: 6,
  })
  assert.deepEqual(invocations.map(({ batch, signal }) => [batch, signal.aborted]), [['a', true], ['b', false]])
  const reopened = await createActionGateway(options)
  assert.deepEqual(await reopened.execute({ ...second, runId: 'no-effect-retry' }), { ...noEffect, replayed: true })
  assert.equal(invocations.length, 2)
})
