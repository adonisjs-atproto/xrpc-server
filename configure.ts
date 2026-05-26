/*
|--------------------------------------------------------------------------
| Configure hook
|--------------------------------------------------------------------------
*/

import { readFile, writeFile } from 'node:fs/promises'
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

  // The package's HTTP dispatch path reads HttpContext via Adonis's
  // per-request ALS — see the spec's Prerequisites section. Without the
  // flag, HTTP-triggered XRPC requests cannot reliably reach the
  // triggering HttpContext from inside atcute's router internals.
  await ensureUseAsyncLocalStorage(command)

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

async function ensureUseAsyncLocalStorage(command: Configure) {
  const configPath = command.app.makePath('config/app.ts')
  const contents = await readFile(configPath, 'utf-8').catch(() => null)
  if (contents === null) return // app does not yet have config/app.ts; nothing to do

  if (/useAsyncLocalStorage\s*:\s*true/.test(contents)) return

  const enable = await command.prompt.confirm(
    'useAsyncLocalStorage is not enabled — enable it now? (required)'
  )
  if (!enable) {
    command.logger.warning(
      'Skipping useAsyncLocalStorage enablement. XRPC HTTP dispatch will fail until you set it manually.'
    )
    return
  }

  // Append `useAsyncLocalStorage: true` to the http config block. If the
  // block already exists we insert into it; if not we add a minimal block.
  const updated = /export\s+const\s+http\s*=\s*defineConfig\(\{/.test(contents)
    ? contents.replace(
        /export\s+const\s+http\s*=\s*defineConfig\(\{/,
        'export const http = defineConfig({\n  useAsyncLocalStorage: true,'
      )
    : contents + `\n\nexport const http = defineConfig({\n  useAsyncLocalStorage: true,\n})\n`
  await writeFile(configPath, updated)
}
