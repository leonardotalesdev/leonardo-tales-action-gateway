import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createActionGateway } from '../dist/index.js'
import { computeSnapshotChecksum as digest } from '../dist/internal/digest.js'
import { openLocalAuditPort, openLocalRecordStore, openReconciliationStore } from '../dist/internal/local-store.js'
import { createReconciliationDecisionKernel } from '../dist/internal/reconciliation-decision.js'
import { readReconciliationSubject } from '../dist/internal/reconciliation.js'
import { taskStoreIdentity } from '../dist/internal/store-manifest.js'
import { promoteTaskStore } from '../dist/internal/store-promotion.js'
import { config, first, projectDirectory, records, time, workspace } from './fixture.mjs'

export async function openHistory(root, legacyDigestLocale) {
  const { projectId } = taskStoreIdentity(config(root).task.id)
  const state = await openLocalRecordStore(join(root, 'state'), projectId, { legacyDigestLocale })
  const audit = await openLocalAuditPort(join(root, 'audit'), projectId)
  return { state, audit, projectId }
}

export async function readSubject(root, operationKey = first.operationKey, legacyDigestLocale) {
  const { state, audit, projectId } = await openHistory(root, legacyDigestLocale)
  return readReconciliationSubject(state, audit, projectId, operationKey)
}

export async function openKernel(root, { now = () => time, ...storeOptions } = {}) {
  const { projectId } = taskStoreIdentity(config(root).task.id)
  const store = await openReconciliationStore(root, projectId, storeOptions)
  return createReconciliationDecisionKernel({ store, now })
}

export function makeQualification(subject, storeGeneration, outcome = 'confirmed-effect', overrides = {}) {
  assert.equal(subject.status, 'eligible')
  const { projectId, taskId, operationKey, attemptId, binding } = subject.subject
  return {
    requestId: 'recovery-request-' + operationKey,
    actorId: 'trusted-resolver',
    projectId, taskId, operationKey, attemptId, executionIdentity: binding.executionIdentity,
    storeGeneration, subjectDigest: subject.subjectDigest, expectedState: subject.expectedState,
    outcome,
    evidenceRef: { id: 'qualified-evidence-' + operationKey, revision: 1 },
    evidenceDigest: digest('dossier-' + operationKey),
    proof: outcome === 'confirmed-effect'
      ? { effectOccurredDigest: digest('effect-' + operationKey) }
      : { effectAbsentDigest: digest('absent-' + operationKey), attemptFinalityDigest: digest('final-' + operationKey) },
    qualifiedAt: time,
    ...overrides,
  }
}

export async function decisionRows(root) {
  return (await records(root, 'action-allowance')).filter(({ envelope }) => envelope.record.id.startsWith('reconciliation-'))
}

export async function auditPath(root) {
  return join(await projectDirectory(root, 'audit'), 'events.jsonl')
}

export async function journal(root) {
  return (await readFile(await auditPath(root), 'utf8')).trimEnd().split('\n').filter(Boolean).map(JSON.parse)
}

export async function promotedAmbiguous(t, outcome = 'confirmed-effect') {
  const root = await workspace(t)
  const options = config(root)
  const calls = { measure: 0, review: 0, handler: 0 }
  options.tool.amount = (input) => { calls.measure++; return input.rows }
  options.review = async () => { calls.review++; return 'APPROVED' }
  options.tool.execute = async () => { calls.handler++; return { outcome: 'unknown' } }
  const gateway = await createActionGateway(options)
  const receipt = await gateway.execute(first)
  assert.equal(receipt.decision, 'UNKNOWN')
  const generation = await promoteTaskStore(root, options.task.id)
  const subject = await readSubject(root)
  assert.equal(subject.observedPrefix, 'reconciliation-required')
  const qualification = makeQualification(subject, generation, outcome)
  return { root, directory: root, options, calls, gateway, receipt, generation, subject, qualification }
}
