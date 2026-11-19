import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActionGateway } from '@leonardo-tales/action-gateway'

const directory = await mkdtemp(join(tmpdir(), 'action-gateway-example-'))
const effects = join(directory, 'exports.jsonl')
const config = {
  directory,
  task: { id: 'case-17', unit: 'rows', cap: 10, expiresAt: '2030-01-01T01:00:00.000Z' },
  approverId: 'demo-operator',
  // Fixed time and automatic approval are fixtures for this synthetic export.
  now: () => '2030-01-01T00:00:00.000Z',
  review: async () => 'APPROVED',
  tool: {
    id: 'customer.export', revision: 1,
    amount(input) { return input.rowIds.length },
    async execute(input) {
      await appendFile(effects, JSON.stringify(input.rowIds) + '\n', { mode: 0o600 })
      return { outcome: 'executed', evidenceId: 'export-starting-at-' + input.rowIds[0] }
    },
  },
}
const requests = [
  { runId: 'run-a', operationKey: 'export-1', input: { rowIds: [1, 2, 3, 4] } },
  { runId: 'run-b', operationKey: 'export-2', input: { rowIds: [5, 6, 7] } },
  { runId: 'run-b', operationKey: 'export-3', input: { rowIds: [8, 9, 10, 11] } },
]
const countEffects = async () => (await readFile(effects, 'utf8')).trim().split('\n').length

try {
  const gateway = await createActionGateway(config)
  console.log('Task case-17   cap 10 rows')
  for (const [index, request] of requests.entries()) {
    const receipt = await gateway.execute(request)
    assert.equal(receipt.decision, ['EXECUTED', 'EXECUTED', 'BLOCKED'][index])
    assert.equal(receipt.remaining, [6, 3, 3][index])
    console.log(receipt.operationKey, receipt.requested, 'rows', receipt.decision, 'remaining', receipt.remaining)
    if (receipt.refusalBasis) {
      assert.equal(receipt.refusalBasis.reason, 'task_limit')
      assert.equal(receipt.refusalBasis.remaining, 3)
      console.log('reason', receipt.refusalBasis.reason, 'available_at_decision', receipt.refusalBasis.remaining)
    }
  }
  assert.equal(await countEffects(), 2)
  console.log('tool effects = 2')
  const reopened = await createActionGateway(config)
  const replay = await reopened.execute({ ...requests[1], runId: 'run-after-restart' })
  assert.equal(replay.decision, 'EXECUTED')
  assert.equal(replay.replayed, true)
  assert.equal(await countEffects(), 2)
  console.log('replay export-2   recorded result   tool effects = 2')
} finally {
  await rm(directory, { recursive: true, force: true })
}
