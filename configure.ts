/*
|--------------------------------------------------------------------------
| Configure hook
|--------------------------------------------------------------------------
*/

import type Configure from '@adonisjs/core/commands/configure'
import { stubsRoot } from './stubs/main.ts'

export async function configure(command: Configure) {
  const packageName = '@thisismissem/adonisjs-atproto-xrpc'

  const codemods = await command.createCodemods()

  await codemods.makeUsingStub(stubsRoot, 'config.stub', {})
  await codemods.makeUsingStub(stubsRoot, 'app/exceptions/xrpc_handler.stub', {})

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider(`${packageName}/provider`)
  })

  const instructions = command.ui.instructions()
  instructions.heading('AT Protocol XRPC setup!')
  instructions.add("Set the ATPROTO_SERVICE_DID env var to this service's DID before booting.")
  instructions.add(
    'Register the XRPC error handler in start/kernel.ts:\n' +
      "  import xrpc from '@thisismissem/adonisjs-atproto-xrpc/services/xrpc'\n" +
      "  xrpc.errorHandler(() => import('#exceptions/xrpc_handler'))"
  )
  instructions.render()
}
