/*
|--------------------------------------------------------------------------
| Configure spec
|--------------------------------------------------------------------------
|
| Exercises the package's configure() hook end-to-end. Boots a fake
| AdonisJS app under an isolated tmp directory, runs the Configure
| command against this package, and asserts on the resulting file
| contents.
*/

import { test } from '@japa/runner'
import { fileURLToPath } from 'node:url'
import { IgnitorFactory } from '@adonisjs/core/factories'
import Configure from '@adonisjs/core/commands/configure'

// TODO: Can this be replaced with helpers.ts?
const BASE_URL = new URL('../tmp/configure/', import.meta.url)

const PACKAGE_NAME = '@thisismissem/adonisjs-atproto-xrpc'
const INSTALL_PROMPT = `Do you want to install additional packages required by "${PACKAGE_NAME}"?`

test.group('Configure', (group) => {
  group.each.setup(({ context }) => {
    context.fs.baseUrl = BASE_URL
    context.fs.basePath = fileURLToPath(BASE_URL)
  })

  group.each.disableTimeout()

  test('correctly configures the package', async ({ fs, assert }) => {
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .create(BASE_URL, {
        importer: (filePath) => {
          if (filePath.startsWith('./') || filePath.startsWith('../')) {
            return import(new URL(filePath, BASE_URL).href)
          }
          return import(filePath)
        },
      })

    await fs.create('.env', '')
    await fs.createJson('tsconfig.json', {})
    await fs.create('start/env.ts', `export default Env.create(new URL('./'), {})`)
    await fs.create(
      'start/kernel.ts',
      `router.use([])
export const { middleware } = router.named({
})`
    )
    await fs.create('adonisrc.ts', `export default defineConfig({})`)

    const app = ignitor.createApp('web')
    await app.init()
    await app.boot()

    const ace = await app.container.make('ace')
    ace.prompt.trap(INSTALL_PROMPT).reject()

    const command = await ace.create(Configure, ['../../index.js'])
    await command['exec']()

    // Config file emitted, but with the in-memory store path
    await assert.fileExists('config/atproto_xrpc.ts')
    await assert.fileContains('config/atproto_xrpc.ts', 'defineConfig({')

    // Exception handler stub is published — consumers extend ExceptionHandler here.
    await assert.fileExists('app/exceptions/xrpc_handler.ts')
    await assert.fileContains('app/exceptions/xrpc_handler.ts', 'extends ExceptionHandler')

    // Provider and env wiring happen regardless of store choice
    await assert.fileContains('adonisrc.ts', `${PACKAGE_NAME}/provider`)
  })

  test('verifies useAsyncLocalStorage is enabled in config/app.ts', async ({ fs, assert }) => {
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .create(BASE_URL, {
        importer: (filePath) => {
          if (filePath.startsWith('./') || filePath.startsWith('../')) {
            return import(new URL(filePath, BASE_URL).href)
          }
          return import(filePath)
        },
      })

    await fs.create('.env', '')
    await fs.createJson('tsconfig.json', {})
    await fs.create('start/env.ts', `export default Env.create(new URL('./'), {})`)
    await fs.create(
      'start/kernel.ts',
      `router.use([])
export const { middleware } = router.named({
})`
    )
    await fs.create('adonisrc.ts', `export default defineConfig({})`)
    // Note: NO useAsyncLocalStorage flag — we expect configure to prompt or note this.
    await fs.create('config/app.ts', `export const http = defineConfig({})`)

    const app = ignitor.createApp('web')
    await app.init()
    await app.boot()

    const ace = await app.container.make('ace')
    ace.prompt.trap(INSTALL_PROMPT).reject()
    // The new prompt — when useAsyncLocalStorage is missing, configure should
    // surface it. The test accepts (chooses "yes, enable it") so the file gets
    // rewritten.
    ace.prompt.trap('useAsyncLocalStorage is not enabled — enable it now? (required)').accept()

    const command = await ace.create(Configure, ['../../index.js'])
    await command['exec']()

    await assert.fileContains('config/app.ts', 'useAsyncLocalStorage')
  })
})
