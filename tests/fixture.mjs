import { appendFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const time = '2030-01-01T00:00:00.000Z'
export const first = { runId: 'run-a', operationKey: 'export-1', input: { rows: 4, batch: 'a' } }
export const second = { runId: 'run-b', operationKey: 'export-2', input: { rows: 3, batch: 'b' } }
export const third = { runId: 'run-c', operationKey: 'export-3', input: { rows: 4, batch: 'c' } }

export async function workspace(t) {
  const path = await mkdtemp(join(tmpdir(), 'action-gateway-test-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

export function config(directory) {
  return {
    directory, now: () => time,
    task: { id: 'case-17', cap: 10, unit: 'rows', expiresAt: '2030-01-01T01:00:00.000Z' },
    approverId: 'operator', review: async () => 'APPROVED',
    tool: {
      id: 'customer.export', revision: 1, amount: (input) => input.rows,
      async execute(input) {
        await appendFile(join(directory, 'effects'), String(input.rows) + '\n')
        return { outcome: 'executed', evidenceId: 'effect-' + input.batch }
      },
    },
  }
}

// Read the actual persisted envelopes independently of the product read path.
export async function records(directory, kind) {
  const [project] = await readdir(join(directory, 'state'))
  const collection = join(directory, 'state', project, kind)
  const names = (await readdir(collection)).filter((name) => name.endsWith('.json'))
  return Promise.all(names.map(async (name) => {
    const path = join(collection, name)
    return { path, envelope: JSON.parse(await readFile(path, 'utf8')) }
  }))
}
