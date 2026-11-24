import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { createTrustedReconciliationHost } from '../dist/index.js'
import { computeSnapshotChecksum as digest } from '../dist/internal/digest.js'
import { config, time } from './fixture.mjs'

const [directory, serialized] = process.argv.slice(2)
const { request, actorId = 'trusted-resolver', outcome = 'confirmed-effect', changes = {},
  pauseAfterAudit, failAfterAudit, loseAcknowledgement } = JSON.parse(serialized)
let resolverCalls = 0
let clockCalls = 0

async function barrier(type, command) {
  const next = once(process, 'message')
  process.send({ type })
  const [received] = await next
  assert.equal(received, command)
}

function pauseUnderStateWriter() {
  // This clock invocation is synchronous. The test driver releases it via stdin
  // after checking the actual filesystem writer in a different process.
  process.send({ type: 'after-audit' })
  const byte = Buffer.alloc(1)
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  const end = performance.now() + 8000
  while (performance.now() < end) {
    try {
      assert.equal(readSync(0, byte), 1)
      assert.equal(byte[0], 1)
      return
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error
      Atomics.wait(sleeper, 0, 0, 10)
    }
  }
  assert.fail('The test driver did not release the clock checkpoint')
}

const controller = await createTrustedReconciliationHost({
  directory,
  taskId: config(directory).task.id,
  host: {
    actorId,
    now() {
      clockCalls++
      if (pauseAfterAudit && clockCalls === 2) pauseUnderStateWriter()
      if (failAfterAudit && clockCalls === 2) throw new Error('test clock failed after the audit event')
      return time
    },
    async resolveEvidence({ requestId, actorId, evidenceRef, subject }) {
      resolverCalls++
      const { expectedState, subjectDigest, operationKey } = subject
      const assessment = {
        status: outcome,
        binding: { requestId, actorId, evidenceRef, subjectDigest, expectedState },
        qualifiedAt: time,
        evidenceDigest: digest('dossier-' + operationKey),
        ...(outcome === 'confirmed-effect' ? { effectOccurredDigest: digest('effect-' + operationKey) } : {
          effectAbsentDigest: digest('absent-' + operationKey),
          attemptFinalityDigest: digest('final-' + operationKey),
        }),
        ...changes,
      }
      await barrier('assessed', 'resolve')
      return assessment
    },
  },
})

await barrier('ready', 'start')
const receipt = await controller.reconcile(request)
if (loseAcknowledgement) {
  assert.equal(receipt.status, 'applied')
  await barrier('durable-without-acknowledgement', 'acknowledge')
}
process.send({ type: 'receipt', receipt, resolverCalls, clockCalls })
process.disconnect()
