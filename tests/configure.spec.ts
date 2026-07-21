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

const PACKAGE_NAME = '@adonisjs-atproto/xrpc-server'
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

    // Provider and env wiring happen regardless of store choice
    await assert.fileContains('adonisrc.ts', `${PACKAGE_NAME}/provider`)
  })
})
