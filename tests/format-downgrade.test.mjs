import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { watch } from 'node:fs'
import { access, mkdir, readFile, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { config, first, persistedFiles, projectDirectory, second, workspace } from './fixture.mjs'
import { promoteTaskStore } from '../dist/internal/store-promotion.js'

const name = '@leonardo-tales/action-gateway'
const artifact = fileURLToPath(new URL('fixtures/action-gateway-0.1.1.registry-tarball.tgz', import.meta.url))
const integrity = 'sha512-/skCiOeclQQEf/T4opVlH+pr1ypqKbb493PwU0VW2k4AqVW5zinCMR/3/w3pzGkRCXWFiw/dgBr9BNxwvlJOJQ=='

async function freeWriters(root) {
  for (const area of ['state', 'audit']) {
    await assert.rejects(access(join(await projectDirectory(root, area), '.writer.lock')), { code: 'ENOENT' })
  }
}

test('the exact published v0.1.1 consumer refuses promoted replay and fresh execution with free writer locks', async (t) => {
  assert.equal('sha512-' + createHash('sha512').update(await readFile(artifact)).digest('base64'), integrity)
  const consumer = await workspace(t)
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'downgrade-fixture', private: true, type: 'module' }))
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-fund', '--no-audit', artifact], {
    cwd: consumer, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', npm_config_cache: join(consumer, 'empty-cache') },
    stdio: 'pipe',
  })
  const entry = join(consumer, 'resolve.mjs')
  await writeFile(entry, `export { createActionGateway } from '${name}'
export const resolved = import.meta.resolve('${name}')`)
  const old = await import(pathToFileURL(entry).href)
  assert.equal(old.resolved, pathToFileURL(join(consumer, 'node_modules', name, 'dist/index.js')).href)
  const installed = JSON.parse(await readFile(join(consumer, 'node_modules', name, 'package.json'), 'utf8'))
  assert.equal(installed.version, '0.1.1')
  assert.equal(installed.bin, undefined)

  const root = join(consumer, 'gateway')
  await mkdir(root, { mode: 0o700 })
  const counts = { measure: 0, review: 0, handler: 0 }
  const options = config(root)
  options.tool.amount = (input) => { counts.measure++; return input.rows }
  options.review = async () => { counts.review++; return 'APPROVED' }
  options.tool.execute = async () => { counts.handler++; return { outcome: 'executed', evidenceId: 'positive-control' } }
  const idle = await old.createActionGateway(options)
  assert.equal((await idle.execute(first)).decision, 'EXECUTED')
  assert.deepEqual(counts, { measure: 1, review: 1, handler: 1 })
  assert.equal((await idle.inspect(first.operationKey)).decision, 'EXECUTED')
  assert.equal(await idle.inspect('missing'), null)

  // The old handle is idle and no worker can resume during the CLI invocation.
  await freeWriters(root)
  const cli = fileURLToPath(new URL('../dist/cli/promote-r2.js', import.meta.url))
  const generation = execFileSync(process.execPath, [cli, '--directory', root, '--task-id', options.task.id], { encoding: 'utf8' })
  assert.match(generation, /^[a-f0-9]{64}\n$/)
  await freeWriters(root)
  const promoted = await persistedFiles(root)
  const reopened = await old.createActionGateway(options)
  const lockEvents = []
  const stateProject = await projectDirectory(root, 'state')
  const watcher = watch(stateProject, (event, path) => { if (path === '.writer.lock') lockEvents.push(event) })
  t.after(() => watcher.close())
  for (const gateway of [idle, reopened]) {
    await assert.rejects(gateway.inspect(first.operationKey), /task-configuration-conflict/)
    assert.equal(await gateway.inspect('missing'), null)
    await assert.rejects(gateway.execute(first), /task-configuration-conflict/)
    await freeWriters(root)
    await assert.rejects(gateway.execute(second), /task-configuration-conflict/)
    await freeWriters(root)
  }
  assert.ok(lockEvents.includes('rename'), 'old execution briefly creates its state writer lock')
  assert.deepEqual(counts, { measure: 1, review: 1, handler: 1 })
  assert.deepEqual(await persistedFiles(root), promoted)

  for (const pause of ['review', 'handler']) {
    await t.test(`a live old ${pause} callback can exist while both writer locks are absent`, async (st) => {
      const data = await workspace(st)
      const settings = config(data)
      const waiting = Promise.withResolvers()
      const release = Promise.withResolvers()
      let continued = false
      const atPause = async () => { waiting.resolve(); await release.promise; continued = true }
      if (pause === 'review') settings.review = async () => { await atPause(); return 'PENDING' }
      else settings.tool.execute = async () => { await atPause(); return { outcome: 'unknown' } }
      const working = await old.createActionGateway(settings)
      const operation = working.execute(first)
      try {
        await Promise.race([waiting.promise, operation.then(() => assert.fail('callback did not pause'))])
        await freeWriters(data)
        assert.equal(continued, false)
        // A live old callback excludes a valid offline fence even with both locks absent.
      } finally { release.resolve(); await operation }
      assert.equal(continued, true)
      await freeWriters(data)
      assert.match(await promoteTaskStore(data, settings.task.id), /^[a-f0-9]{64}$/)
      if (pause === 'review') {
        const emptyExecution = join(await projectDirectory(data, 'state'), 'execution')
        await rmdir(emptyExecution)
        const beforeOpen = await persistedFiles(data)
        await old.createActionGateway(settings)
        await access(emptyExecution)
        assert.deepEqual(await persistedFiles(data), beforeOpen)
      }
    })
  }
})
