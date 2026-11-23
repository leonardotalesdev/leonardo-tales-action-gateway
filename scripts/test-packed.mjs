import assert from 'node:assert/strict'
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
    "await assert.rejects(import('@leonardo-tales/action-gateway/dist/internal/execution-gateway.js'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'})",
    "const receipt = await verify(process.cwd() + '/data')",
    "assert.equal(receipt.decision, 'EXECUTED')",
    "assert.equal(receipt.remaining, 0)",
  ].join('\n')])
  await copyFile(join(installed, 'examples/row-export/index.mjs'), join(consumer, 'example.mjs'))
  const output = run(process.execPath, ['example.mjs'])
  assert.match(output, /reason task_limit available_at_decision 3/)
  assert.match(output, /replay export-2 +recorded result +tool effects = 2/)
  console.log(pack.filename, pack.integrity, '(' + pack.files.length + ' files)')
  console.log('Offline tarball install, zero runtime dependencies, strict TypeScript consumer, public ESM entry and guarded execution passed.')
  process.stdout.write(output)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
