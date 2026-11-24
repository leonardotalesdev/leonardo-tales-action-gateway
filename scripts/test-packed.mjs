import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = await realpath(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
assert.ok(args.length <= 1, 'usage: npm run test:packed -- [/absolute/external/candidate.tgz]')
let candidatePath
if (args.length === 1) {
  const [destination] = args
  assert.ok(isAbsolute(destination) && destination.endsWith('.tgz'), 'candidate destination must be an absolute .tgz path')
  const parent = await realpath(dirname(destination))
  const fromRoot = relative(root, parent)
  assert.ok(fromRoot === '..' || fromRoot.startsWith('../'), 'candidate destination must be outside the repository')
  candidatePath = join(parent, basename(destination))
}
const scratch = await mkdtemp(join(tmpdir(), 'packed-action-gateway-'))
const consumer = join(scratch, 'consumer')
const name = '@leonardo-tales/action-gateway'
const version = '0.2.0'
const rowExportExample = 'examples/row-export/index.mjs'
const reconciliationExample = 'examples/trusted-reconciliation/index.mjs'
const binName = 'lt-action-gateway-promote-r2'
const binTarget = 'dist/cli/promote-r2.js'
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', npm_config_offline: 'true',
  npm_config_update_notifier: 'false', npm_config_cache: join(scratch, 'empty-cache') }
function scalarDigest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function archiveIntegrity(bytes) { return 'sha512-' + createHash('sha512').update(bytes).digest('base64') }
function run(bin, args, cwd = consumer, commandEnv = env) {
  return execFileSync(bin, args, { cwd, env: commandEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

try {
  await mkdir(consumer)
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', scratch], root))
  const archive = join(scratch, pack.filename)
  const archiveBytes = await readFile(archive)
  const integrity = archiveIntegrity(archiveBytes)
  assert.equal(pack.integrity, integrity)
  assert.equal(pack.size, archiveBytes.length)
  assert.equal(pack.name, name)
  assert.equal(pack.version, version)
  const distEntries = await readdir(join(root, 'dist'), { recursive: true, withFileTypes: true })
  const distFiles = distEntries.filter((entry) => !entry.isDirectory()).map((entry) => {
    const path = relative(root, join(entry.parentPath, entry.name))
    assert.ok(entry.isFile() && /\.(js|d\.ts)$/.test(path), path)
    return path
  })
  assert.equal(distFiles.length, 46)
  const expectedPaths = [...distFiles, 'LICENSE', 'LICENSES/Apache-2.0.txt', 'README.md', 'package.json',
    rowExportExample, reconciliationExample].sort()
  assert.equal(pack.files.length, 52)
  assert.deepEqual(pack.files.map(({ path }) => path).sort(), expectedPaths)
  for (const { path, mode } of pack.files) {
    assert.ok(Number.isInteger(mode), path + ' archive mode')
    if (path !== binTarget) assert.equal(mode & 0o111, 0, path + ' unexpected executable mode')
  }

  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'packed-consumer', private: true, type: 'module' }))
  run('npm', ['install', '--offline', '--no-audit', '--no-fund', archive])
  const consumerLock = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'))
  assert.equal(consumerLock.packages['node_modules/' + name].integrity, integrity)
  const tree = JSON.parse(run('npm', ['ls', '--omit=dev', '--all', '--json']))
  assert.deepEqual(Object.keys(tree.dependencies), [name])
  assert.equal(tree.dependencies[name].version, pack.version)
  assert.equal(Object.keys(tree.dependencies[name].dependencies ?? {}).length, 0)

  const installed = join(consumer, 'node_modules', name)
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(manifest.name, name)
  assert.equal(manifest.version, version)
  assert.equal(manifest.license, 'Apache-2.0')
  assert.deepEqual(manifest.os, ['linux'])
  assert.deepEqual(manifest.engines, { node: '>=22.18.0' })
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']) {
    assert.deepEqual(Object.keys(manifest[key] ?? {}), [], key)
  }
  assert.deepEqual(manifest.exports, { '.': { types: './dist/index.d.ts', import: './dist/index.js' } })
  assert.deepEqual(manifest.files, ['dist', rowExportExample, reconciliationExample, 'README.md', 'LICENSE', 'LICENSES'])
  const bin = join(consumer, 'node_modules', '.bin', binName)
  assert.equal(manifest.bin[binName].replace(/^\.\//, ''), binTarget)
  assert.deepEqual(Object.keys(manifest.bin), [binName])
  assert.match(await readFile(join(installed, binTarget), 'utf8'), /^#!\/usr\/bin\/env node\n/)
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
    "assert.deepEqual(Object.keys(api), ['createActionGateway', 'createTrustedReconciliationHost'])",
    ...['internal/execution-gateway', 'internal/store-promotion', 'internal/reconciliation',
      'internal/reconciliation-decision', 'internal/reconciliation-record', 'internal/local-store',
      'internal/trusted-reconciliation-host', 'cli/promote-r2'].flatMap((path) =>
      [path, `dist/${path}.js`].map((specifier) =>
        `await assert.rejects(import('${name}/${specifier}'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })`)),
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
  const promotionArgs = ['--directory', join(consumer, 'data'), '--task-id', 'consumer-task']
  const generation = run(bin, promotionArgs)
  assert.match(generation, /^[a-f0-9]{64}\n$/)
  const promoted = await readFile(manifestPath, 'utf8')
  assert.equal(JSON.parse(promoted).record.revision, 2)
  assert.equal(JSON.parse(promoted).record.payload.storeGeneration, generation.trim())
  assert.equal(run(bin, promotionArgs), generation)
  assert.equal(await readFile(manifestPath, 'utf8'), promoted)
  run(process.execPath, ['--input-type=module', '-e', [
    "import assert from 'node:assert/strict'",
    "import { prepareReconciliation } from './out/consumer.js'",
    "assert.equal((await prepareReconciliation(process.cwd() + '/data')).decision, 'UNKNOWN')",
  ].join('\n')])
  assert.match(run(bin, ['--directory', join(consumer, 'data'), '--task-id', 'recovery-task']), /^[a-f0-9]{64}\n$/)
  run(process.execPath, ['--input-type=module', '-e', [
    "import assert from 'node:assert/strict'",
    "import { verifyReconciliation } from './out/consumer.js'",
    "const { controllerKeys, receipt, replay } = await verifyReconciliation(process.cwd() + '/data')",
    "assert.deepEqual(controllerKeys, ['reconcile'])",
    "assert.equal(receipt.status, 'applied')",
    "assert.equal(receipt.outcome, 'reconciled-effect')",
    "assert.deepEqual(replay, { ...receipt, status: 'replayed' })",
  ].join('\n')])
  for (const path of [rowExportExample, reconciliationExample]) {
    const source = await readFile(join(installed, path), 'utf8')
    for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
      assert.ok(fileName === name || isBuiltin(fileName), path + ' imports ' + fileName)
    }
  }
  // The installed CLI uses an env-based shebang. Give examples Node on PATH without inheriting credentials.
  const exampleEnv = { PATH: dirname(process.execPath) }
  const output = run(process.execPath, [join(installed, rowExportExample)], consumer, exampleEnv)
  assert.match(output, /reason task_limit available_at_decision 3/)
  assert.match(output, /replay export-2 +recorded result +tool effects = 2/)
  const reconciliationOutput = run(process.execPath, [join(installed, reconciliationExample), bin], consumer, exampleEnv)
  assert.equal(reconciliationOutput, [
    'original UNKNOWN held 4 remaining 6 handler_calls 1',
    'reconciliation applied reconciled-effect settled 4 remaining 6',
    'replay replayed resolver_calls 0 clock_calls 0 handler_calls 1',
    '',
  ].join('\n'))

  const npmVersion = run('npm', ['--version']).trim()
  assert.deepEqual(await readFile(archive), archiveBytes, 'candidate archive changed during verification')
  if (candidatePath) {
    await copyFile(archive, candidatePath, constants.COPYFILE_EXCL)
    assert.deepEqual(await readFile(candidatePath), archiveBytes, 'retained archive differs from verified bytes')
  }
  console.log('Offline tarball install, public ESM and TypeScript, private subpath checks, installed promotion and both installed examples passed.')
  process.stdout.write(output)
  process.stdout.write(reconciliationOutput)
  console.log(JSON.stringify({
    filename: pack.filename, version, size: archiveBytes.length, integrity, fileCount: pack.files.length,
    node: process.version, npm: npmVersion, files: pack.files, retained: candidatePath ?? null, verified: true,
  }))
} finally {
  await rm(scratch, { recursive: true, force: true })
}
