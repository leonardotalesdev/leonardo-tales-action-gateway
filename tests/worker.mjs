import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { createActionGateway } from '@leonardo-tales/action-gateway'
import { config, first, second } from './fixture.mjs'

const [directory, mode] = process.argv.slice(2)
const options = config(directory)
if (mode === 'crash') {
  options.tool.execute = async (input) => {
    const file = await open(join(directory, 'effects'), 'a', 0o600)
    try {
      await file.writeFile(String(input.rows) + '\n')
      await file.sync()
    } finally {
      await file.close()
    }
    process.exit(77)
  }
  await (await createActionGateway(options)).execute(first)
} else if (mode === 'hold') {
  options.tool.execute = async () => {
    const release = once(process, 'message')
    process.send('entered-handler')
    await release
    return { outcome: 'no-effect', evidenceId: 'verified-empty-export' }
  }
  const result = await (await createActionGateway(options)).execute(second)
  process.send(result)
  process.disconnect()
} else if (mode === 'contend') {
  const key = process.argv[4]
  options.review = async () => {
    const approval = once(process, 'message')
    process.send('at-review')
    await approval
    return 'APPROVED'
  }
  const gateway = await createActionGateway(options)
  await gateway.execute({ runId: key, operationKey: key, input: { rows: 2, batch: key } })
  process.disconnect()
} else {
  throw new Error('unexpected worker mode')
}
