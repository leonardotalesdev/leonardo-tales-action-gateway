import assert from 'node:assert/strict'
import { time } from './fixture.mjs'
import { openKernel } from './reconciliation-decision-fixture.mjs'

const [root, fault, serializedQualification] = process.argv.slice(2)
const qualification = JSON.parse(serializedQualification)

function cutPowerAt(stage) {
  if (fault === stage) process.kill(process.pid, 'SIGKILL')
}

let stateWrites = 0
let samples = 0
const kernel = await openKernel(root, {
  now() {
    cutPowerAt(++samples === 1 ? 'before-qualification' : 'after-audit')
    return time
  },
  stateCheckpoint(stage) {
    if (stage === 'temporary-synced') stateWrites++
    cutPowerAt(`${stateWrites === 1 ? 'qualification' : 'application'}:${stage}`)
  },
  auditCheckpoint(stage) { cutPowerAt(`audit:${stage}`) },
})
const handle = kernel.issuer.issue(qualification)
cutPowerAt('before-state-lock')
await kernel.adjudicator.apply(handle)
assert.fail('The worker completed without reaching the requested crash boundary')
