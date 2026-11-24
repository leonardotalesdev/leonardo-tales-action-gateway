import {
  createActionGateway, createTrustedReconciliationHost, type ActionGatewayOptions, type ActionReceipt,
  type TrustedReconciliationAssessment, type TrustedReconciliationContext, type TrustedReconciliationHost,
  type TrustedReconciliationHostOptions, type TrustedReconciliationReceipt, type TrustedReconciliationRefusalCode,
  type TrustedReconciliationRequest,
} from '@leonardo-tales/action-gateway'

export async function verify(directory: string): Promise<ActionReceipt> {
  const config: ActionGatewayOptions = {
    directory,
    task: { id: 'consumer-task', unit: 'rows', cap: 1, expiresAt: '2030-01-02T00:00:00.000Z' },
    now: () => '2030-01-01T00:00:00.000Z',
    approverId: 'test-operator',
    review: async (request) => request.amount === 1 ? 'APPROVED' : 'DENIED',
    tool: {
      id: 'customer.export', revision: 1,
      amount: ({ rows }) => {
        if (typeof rows !== 'number') throw new Error('rows must be numeric')
        return rows
      },
      execute: async () => ({ outcome: 'executed', evidenceId: 'consumer-export' }),
    },
  }
  const gateway = await createActionGateway(config)
  return gateway.execute({ runId: 'a', operationKey: 'export-1', input: { rows: 1 } })
}

const recoveryTime = '2030-01-01T00:00:00.000Z'
const request: TrustedReconciliationRequest = {
  requestId: 'recovery-request', operationKey: 'ambiguous', evidenceRef: { id: 'consumer-evidence', revision: 4 },
}

export async function prepareReconciliation(directory: string): Promise<ActionReceipt> {
  const gateway = await createActionGateway({
    directory, task: { id: 'recovery-task', unit: 'rows', cap: 1, expiresAt: '2030-01-02T00:00:00.000Z' },
    now: () => recoveryTime, approverId: 'test-operator', review: async () => 'APPROVED',
    tool: { id: 'customer.export', revision: 1, amount: () => 1, execute: async () => ({ outcome: 'unknown' }) },
  })
  return gateway.execute({ runId: 'original', operationKey: request.operationKey, input: { rows: 1 } })
}

export async function verifyReconciliation(directory: string) {
  const options: TrustedReconciliationHostOptions = {
    directory, taskId: 'recovery-task',
    host: {
      actorId: 'recovery-operator', now: () => recoveryTime,
      async resolveEvidence(context: TrustedReconciliationContext, signal): Promise<TrustedReconciliationAssessment> {
        if (signal.aborted || context.subject.observedPrefix !== 'reconciliation-required') return { status: 'unresolved' }
        const { requestId, actorId, evidenceRef, subject: { subjectDigest, expectedState } } = context
        return {
          status: 'confirmed-effect', binding: { requestId, actorId, evidenceRef, subjectDigest, expectedState },
          evidenceDigest: 'a'.repeat(64), effectOccurredDigest: 'b'.repeat(64), qualifiedAt: recoveryTime,
        }
      },
    },
  }
  const controller: TrustedReconciliationHost = await createTrustedReconciliationHost(options)
  const receipt: TrustedReconciliationReceipt = await controller.reconcile(request)
  if (receipt.status === 'refused') {
    const code: TrustedReconciliationRefusalCode = receipt.code
    throw new Error(code)
  }
  if (receipt.status !== 'applied' || receipt.outcome !== 'reconciled-effect') throw new Error('expected applied effect')
  return { controllerKeys: Object.keys(controller), receipt, replay: await controller.reconcile(request) }
}

// This function is typechecked by the isolated consumer and never invoked.
function rejectedCapabilities(controller: TrustedReconciliationHost, gateway: Awaited<ReturnType<typeof createActionGateway>>) {
  // @ts-expect-error caller input cannot supply an outcome
  void controller.reconcile({ ...request, outcome: 'confirmed-effect' })
  // @ts-expect-error caller input cannot supply the authenticated actor
  void controller.reconcile({ ...request, actorId: 'other-operator' })
  // @ts-expect-error caller input cannot supply proof
  void controller.reconcile({ ...request, proof: { effectOccurredDigest: 'b'.repeat(64) } })
  // @ts-expect-error issuer authority is private
  void controller.issue(request)
  // @ts-expect-error normal execution surface has no reconciliation capability
  void gateway.reconcile(request)
}
