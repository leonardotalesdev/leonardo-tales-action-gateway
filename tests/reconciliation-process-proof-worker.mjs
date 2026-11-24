import assert from 'node:assert/strict'
import { once } from 'node:events'
import { constants, readSync } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { proofRequest } from './reconciliation-process-proof-fixture.mjs'
import { config, projectDirectory, time } from './fixture.mjs'
import { computeSnapshotChecksum as digest } from '../dist/internal/digest.js'

const [root, serialized] = process.argv.slice(2)
const {
  request = proofRequest, actorId = 'trusted-resolver', outcome = 'confirmed-effect',
  changes = {}, pauseClock, failResolver, failClock, loseAcknowledgement,
  legacyDigestLocale, failRev2Sync,
} = JSON.parse(serialized)
let resolverCalls = 0
let clockCalls = 0
let uncertainDirectory
let syncFaults = 0
const installs = []
const decisionsDirectory = join(await projectDirectory(root, 'state'), 'action-allowance')

// Observe actual canonical installs. The fault applies only to the directory
// sync after this worker's own revision-2 rename in this isolated fixture.
const { open, rename, readFile } = fs
fs.rename = async (source, target) => {
  const record = dirname(target) === decisionsDirectory
    ? JSON.parse(await readFile(source, 'utf8')).record : undefined
  await rename(source, target)
  if (record?.id.startsWith('reconciliation-')) {
    installs.push(record.revision)
    if (failRev2Sync && record.revision === 2) uncertainDirectory = dirname(target)
  }
}
if (failRev2Sync) {
  fs.open = async (path, flags, ...args) => {
    const handle = await open(path, flags, ...args)
    if (path === uncertainDirectory && (flags & constants.O_DIRECTORY)) {
      handle.sync = async () => {
        uncertainDirectory = undefined
        syncFaults++
        throw new Error('fixture revision-2 directory sync failure')
      }
    }
    return handle
  }
}
syncBuiltinESMExports()
const { createTrustedReconciliationHost } = await import('../dist/index.js')

async function command(expectedType, report) {
  const pending = once(process, 'message')
  process.send(report)
  const [message] = await pending
  assert.equal(message.type, expectedType)
  return message
}

function pauseInWriter() {
  process.send({ type: 'writer-held', clockCalls })
  const byte = Buffer.alloc(1)
  const wait = new Int32Array(new SharedArrayBuffer(4))
  const deadline = performance.now() + 15_000
  while (performance.now() < deadline) {
    try {
      assert.equal(readSync(0, byte), 1)
      assert.equal(byte[0], 1)
      return
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error
      // Stdin is nonblocking under fork. Only the parent's byte releases this barrier.
      Atomics.wait(wait, 0, 0, 10)
    }
  }
  assert.fail('parent did not release the application writer')
}

async function run() {
  let controller
  try {
    controller = await createTrustedReconciliationHost({
      directory: root, taskId: config(root).task.id, legacyDigestLocale,
      host: {
        actorId,
        now() {
          clockCalls++
          assert.ok(!failClock, 'unexpected trusted-clock call')
          if (clockCalls === pauseClock) pauseInWriter()
          return time
        },
        async resolveEvidence(context) {
          resolverCalls++
          assert.ok(!failResolver, 'unexpected trusted resolver call')
          const { requestId, actorId, evidenceRef, subject } = context
          const { operationKey, expectedState, subjectDigest } = subject
          const assessment = outcome === 'unresolved' ? { status: 'unresolved' } : {
            status: outcome,
            binding: { requestId, actorId, evidenceRef, expectedState, subjectDigest },
            qualifiedAt: time,
            evidenceDigest: digest('dossier-' + operationKey),
            ...(outcome === 'confirmed-effect' ? { effectOccurredDigest: digest('effect-' + operationKey) } : {
              effectAbsentDigest: digest('absent-' + operationKey), attemptFinalityDigest: digest('final-' + operationKey),
            }),
            ...changes,
          }
          const { epoch } = await command('release', { type: 'assessed', context, assessment })
          assert.ok(Number.isSafeInteger(epoch) && epoch > 0)
          process.send({ type: 'released', epoch })
          return assessment
        },
      },
    })
  } catch (error) {
    assert.equal(typeof error.code, 'string')
    return { status: 'refused', code: error.code }
  }
  await command('start', { type: 'ready', ambientLocale: Intl.Collator().resolvedOptions().locale })
  const receipt = await controller.reconcile(request)
  if (loseAcknowledgement) {
    assert.equal(receipt.status, 'applied')
    await command('acknowledge', { type: 'durable-without-acknowledgement', installs })
  }
  return receipt
}

const receipt = await run()
const result = { type: 'result', receipt, resolverCalls, clockCalls, installs }
if (failRev2Sync) result.syncFaults = syncFaults
await new Promise((resolve, reject) => {
  process.send(result, (error) => error ? reject(error) : resolve())
})
process.disconnect()
