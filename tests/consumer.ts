import { createActionGateway, type ActionGatewayOptions, type ActionReceipt } from '@leonardo-tales/action-gateway'

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
