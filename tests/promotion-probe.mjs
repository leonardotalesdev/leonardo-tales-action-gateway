// Child-only filesystem and ICU observations for the actual CLI program.
import { appendFileSync, constants } from 'node:fs'
import fs from 'node:fs/promises'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { dirname } from 'node:path'

const { R2_PROBE, R2_FAULT, R2_MANIFEST, R2_CHANGE, R2_ADD_AUDIT_LOCK } = process.env
// A CLI run must never instantiate either Gateway factory.
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context)
    if (!/\/dist\/internal\/(?:action-gateway|execution-gateway)\.js$/.test(url)) return loaded
    const source = Buffer.from(loaded.source).toString('utf8')
    const guarded = source.replace(/function (createActionGateway|createTrustedExecutionGateway)\(options\) \{/,
      'function $1(options) { throw new Error("promotion attempted to construct a Gateway");')
    if (source === guarded) throw new Error('missing Gateway test trap')
    return { ...loaded, source: guarded }
  },
})
const { open, rename, writeFile } = fs
const Collator = Intl.Collator
let renamed = false
function note(message) { appendFileSync(R2_PROBE, message + '\n') }
function dieAt(stage) {
  if (R2_FAULT === stage) process.kill(process.pid, 'SIGKILL')
}
Intl.Collator = new Proxy(Collator, {
  construct(target, [locale, options]) {
    note((options?.localeMatcher === 'best fit' ? 'locale-validation ' : 'collator ') + locale)
    return new target(locale, options)
  },
})
fs.open = async (path, flags, ...args) => {
  if (typeof flags === 'number' && (flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC))) {
    note('open-write ' + path)
  }
  const temporary = R2_MANIFEST && path.startsWith(R2_MANIFEST + '.tmp-')
  if (temporary) dieAt('before-temp')
  const handle = await open(path, flags, ...args)
  const sync = handle.sync.bind(handle)
  if (path.endsWith('/.writer.lock') && flags & constants.O_CREAT) {
    handle.sync = async () => {
      await sync()
      dieAt('lock-owned')
      if (R2_ADD_AUDIT_LOCK) await writeFile(R2_ADD_AUDIT_LOCK, 'audit writer', { flag: 'wx' })
      if (R2_CHANGE) await writeFile(R2_CHANGE, Buffer.concat([await fs.readFile(R2_CHANGE), Buffer.from(' ')]))
    }
  }
  if (temporary) {
    if (R2_FAULT === 'partial-temp') {
      const write = handle.writeFile.bind(handle)
      handle.writeFile = async (text, encoding) => {
        await write(text.slice(0, text.length / 2), encoding)
        dieAt('partial-temp')
      }
    }
    handle.sync = async () => { await sync(); dieAt('temp-synced') }
  }
  if (renamed && path === dirname(R2_MANIFEST) && flags & constants.O_DIRECTORY) {
    handle.sync = async () => {
      if (R2_FAULT === 'uncertain') throw new Error('injected directory sync failure')
      await sync()
      dieAt('directory-synced')
    }
  }
  return handle
}
fs.rename = async (...args) => {
  note('rename ' + args[1])
  await rename(...args)
  if (args[1] === R2_MANIFEST) { renamed = true; dieAt('renamed') }
}
for (const method of ['mkdir', 'unlink', 'writeFile', 'appendFile', 'truncate']) {
  const original = fs[method]
  fs[method] = async (...args) => {
    note(method + ' ' + args[0])
    return original(...args)
  }
}
if (R2_FAULT === 'before-stdout') {
  process.stdout.write = () => dieAt('before-stdout')
}
syncBuiltinESMExports()
