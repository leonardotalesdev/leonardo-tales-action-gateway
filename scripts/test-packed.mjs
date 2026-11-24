import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'packed-action-gateway-'))
const consumer = join(scratch, 'consumer')
const name = '@leonardo-tales/action-gateway'
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', npm_config_offline: 'true', npm_config_cache: join(scratch, 'empty-cache') }
function scalarDigest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function run(bin, args, cwd = consumer) {
  return execFileSync(bin, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

try {
  await mkdir(consumer)
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', scratch], root))
  assert.equal(pack.name, name)
  assert.equal(pack.version, '0.1.1')
  assert.ok(pack.files.every(({ path }) => /^(dist\/[^/].*\.(js|d\.ts)|LICENSE|LICENSES\/Apache-2.0\.txt|README\.md|package\.json|examples\/row-export\/index\.mjs)$/.test(path)))
  for (const path of ['LICENSE', 'LICENSES/Apache-2.0.txt', 'dist/index.js', 'dist/index.d.ts', 'examples/row-export/index.mjs']) {
    assert.ok(pack.files.some((file) => file.path === path), path)
  }

  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'packed-consumer', private: true, type: 'module' }))
  run('npm', ['install', '--offline', '--no-audit', '--no-fund', join(scratch, pack.filename)])
  const tree = JSON.parse(run('npm', ['ls', '--omit=dev', '--all', '--json']))
  assert.deepEqual(Object.keys(tree.dependencies), [name])
  assert.equal(tree.dependencies[name].version, pack.version)
  assert.equal(Object.keys(tree.dependencies[name].dependencies ?? {}).length, 0)

  const installed = join(consumer, 'node_modules', name)
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), [])
  assert.deepEqual(Object.keys(manifest.exports), ['.'])
  const binName = 'lt-action-gateway-promote-r2'
  const bin = join(consumer, 'node_modules', '.bin', binName)
  assert.equal(manifest.bin[binName].replace(/^\.\//, ''), 'dist/cli/promote-r2.js')
  assert.deepEqual(Object.keys(manifest.bin), [binName])
  assert.match(await readFile(join(installed, 'dist/cli/promote-r2.js'), 'utf8'), /^#!\/usr\/bin\/env node\n/)
  const shipped = new Set(pack.files.map((file) => file.path))
  for (const path of shipped) {
    if (!path.startsWith('dist/') || !path.endsWith('.js')) continue
    const source = await readFile(join(installed, path), 'utf8')
    for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
      if (isBuiltin(fileName)) continue
      assert.ok(fileName.startsWith('.') && shipped.has(join(dirname(path), fileName)), path + ' imports ' + fileName)
    }
  }
  await copyFile(join(root, 'tests/consumer.ts'), join(consumer, 'consumer.ts'))
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'NodeNext', target: 'ES2022', strict: true, types: [], lib: ['ES2022', 'DOM'], outDir: 'out' },
    files: ['consumer.ts'],
  }))
  // Only the compiler is supplied by the harness. All imports resolve in the consumer.
  run(process.execPath, [tsc, '-p', 'tsconfig.json'])
  await mkdir(join(consumer, 'data'), { mode: 0o700 })
  run(process.execPath, ['--input-type=module', '-e', [
    "import assert from 'node:assert/strict'",
    "import * as api from '@leonardo-tales/action-gateway'",
    "import { verify } from './out/consumer.js'",
    "assert.deepEqual(Object.keys(api), ['createActionGateway'])",
    ...['internal/execution-gateway', 'internal/store-promotion', 'internal/reconciliation',
      'internal/reconciliation-decision', 'cli/promote-r2'].map((path) =>
      `await assert.rejects(import('${name}/dist/${path}.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })`),
    "const gateway = await api.createActionGateway({ directory: process.cwd() + '/data', task: { id: 'consumer-task', cap: 1, unit: 'rows', expiresAt: '2030-01-02T00:00:00.000Z' }, approverId: 'test-operator', review: async () => 'PENDING', tool: { id: 'customer.export', revision: 1, amount: () => 1, execute: async () => ({ outcome: 'unknown' }) } })",
    "assert.deepEqual(Object.keys(gateway).sort(), ['execute', 'inspect'])",
    "const receipt = await verify(process.cwd() + '/data')",
    "assert.equal(receipt.decision, 'EXECUTED')",
    "assert.equal(receipt.remaining, 0)",
  ].join('\n')])
  const manifestPath = join(consumer, 'data', 'state',
    // Stable Task and record filenames use the public format's scalar SHA-256.
    scalarDigest('project-action-' + scalarDigest('consumer-task')), 'action-allowance', scalarDigest('task-allowance') + '.json')
  const original = await readFile(manifestPath, 'utf8')
  assert.equal(JSON.parse(original).record.revision, 1)
  const importer = run(process.execPath, ['--input-type=module', '-e', `await import('${name}')`])
  assert.equal(importer, '')
  assert.equal(await readFile(manifestPath, 'utf8'), original)
  const args = ['--directory', join(consumer, 'data'), '--task-id', 'consumer-task']
  const generation = run(bin, args)
  assert.match(generation, /^[a-f0-9]{64}\n$/)
  const promoted = await readFile(manifestPath, 'utf8')
  assert.equal(JSON.parse(promoted).record.revision, 2)
  assert.equal(JSON.parse(promoted).record.payload.storeGeneration, generation.trim())
  assert.equal(run(bin, args), generation)
  assert.equal(await readFile(manifestPath, 'utf8'), promoted)
  await copyFile(join(installed, 'examples/row-export/index.mjs'), join(consumer, 'example.mjs'))
  const output = run(process.execPath, ['example.mjs'])
  assert.match(output, /reason task_limit available_at_decision 3/)
  assert.match(output, /replay export-2 +recorded result +tool effects = 2/)
  console.log(pack.filename, pack.integrity, '(' + pack.files.length + ' files)')
  console.log('Offline tarball install, zero runtime dependencies, strict TypeScript consumer, public ESM entry, installed maintenance bin and guarded execution passed.')
  process.stdout.write(output)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
