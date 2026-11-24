import assert from 'node:assert/strict'
import { lstatSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { createActionGateway } from '../dist/index.js'
import { createTaskRunStore } from '../dist/internal/task-run-store.js'
import { transitionRun } from '../dist/internal/task-run.js'
import { second } from './fixture.mjs'
import { openHistory, readSubject } from './reconciliation-decision-fixture.mjs'
import { proofConfig, writerPath } from './reconciliation-process-proof-fixture.mjs'

const [root, entryLog, role] = process.argv.slice(2)
const { state, audit, projectId } = await openHistory(root)
let message

if (role === 'extend-run') {
  const { subject } = await readSubject(root)
  const { taskId, binding } = subject
  const revision = await state.exclusive(async (port) => {
    const workflow = createTaskRunStore(port, projectId)
    const { task } = await workflow.loadTask(taskId)
    const run = await workflow.loadRun(binding.runId)
    assert.equal(run.status, 'blocked')
    const extension = transitionRun(task, run, {
      id: 'authorized-test-run-extension', type: 'reconcile', projectId, taskId, runId: run.id,
      expectedRevision: run.revision, blockedRevision: run.revision, occurredAt: '2030-01-01T00:00:00.001Z',
      actionRef: binding.proposalRef, resolution: 'resolved', resolutionRef: { id: 'external-resolution', revision: 1 },
    })
    assert.equal(extension.status, 'applied')
    const saved = await workflow.saveRun(extension.run, run.revision)
    assert.equal(saved.status, 'paused')
    assert.equal(saved.revision, run.revision + 1)
    return saved.revision
  })
  message = { type: 'run-extended', runId: binding.runId, revision }
} else {
  assert.equal(role, 'unrelated-operation')
  const stateLock = await writerPath(root)
  const auditLock = await writerPath(root, 'audit')
  await state.exclusive(async (port) => {
    assert.equal((await lstat(stateLock)).isFile(), true)
    assert.equal((await port.read('action-allowance', 'task-allowance')).revision, 2)
  })
  await audit.appendLine(() => {
    assert.equal(lstatSync(auditLock).isFile(), true)
    return null
  })
  const gateway = await createActionGateway(proofConfig({ root, entryLog }, 'executed'))
  const receipt = await gateway.execute(second)
  message = { type: 'unrelated-finished', receipt }
}

await new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve()))
process.disconnect()
