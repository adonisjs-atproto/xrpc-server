import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor'
import { TestUtilsFactory } from '@adonisjs/core/factories/core/test_utils'
import { getActiveTest } from '@japa/runner'
import { createServer } from 'node:http'
import type { AppEnvironments } from '@adonisjs/core/types/app'

export const BASE_URL = new URL('../tmp/', import.meta.url)
export const IMPORTER = (filePath: string) => {
  if (filePath.startsWith('./') || filePath.startsWith('../')) {
    return import(new URL(filePath, BASE_URL).href)
  }
  return import(filePath)
}

type SetupAppParameters = Parameters<IgnitorFactory['merge']>[0] & {
  /**
   * Override the AdonisJS environment the test app runs in. Defaults to
   * 'test'. Pass 'console' to exercise console-only behavior (e.g.
   * provider.ready() skipping XrpcServer wiring).
   */
  environment?: AppEnvironments
}

/**
 * Setup an AdonisJS app for testing the labeler package.
 *
 * Returns an isolated app instance with @adonisjs/lucid + better-sqlite3
 * pointed at an in-memory database, AND with the xrpc package
 * registered.
 *
 * Tests can override defaults via the `parameters` argument (forwarded
 * to IgnitorFactory.merge). Tests that need to swap container bindings
 * before `provider.ready()` runs can pass a `beforeReady` hook in the
 * second argument — it fires between `app.boot()` (provider register +
 * boot complete) and `testUtils.boot()` (provider ready about to fire).
 *
 * Pass `environment: 'console'` (or another non-default env) to bypass
 * TestUtilsFactory's hardcoded `'test'` environment.
 *
 * App teardown is registered automatically when called from inside a
 * Japa test body (`getActiveTest()` returns the active test). When
 * called from `group.each.setup` (where there is no active test yet),
 * teardown is not auto-registered — callers should `return terminate`
 * from the setup hook to wire it via Japa's setup-teardown convention.
 */
export async function setupApp(
  parameters: SetupAppParameters = {},
  hooks: { beforeReady?: (app: any) => void | Promise<void> } = {}
) {
  const { environment, ...mergeParams } = parameters
  const factory = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: {
        providers: [
          // () => import('../providers/provider.js'),
        ],
      },
      config: {},
    })
    .merge(mergeParams)

  const ignitor = factory.create(BASE_URL, { importer: IMPORTER })
  // TestUtilsFactory hardcodes `'test'` env; bypass when a different env
  // is requested.
  const testUtils = environment
    ? await createTestUtilsForEnv(ignitor, environment)
    : new TestUtilsFactory().create(ignitor)

  await testUtils.app.init()
  await testUtils.app.boot()
  if (hooks.beforeReady) await hooks.beforeReady(testUtils.app)
  await testUtils.boot()

  await testUtils.app.start(async () => {
    // Attach a Node http.Server WITHOUT calling .listen() — gives
    // appServer.getNodeServer() a target so XrpcServer.#installWebSocketHandler
    // can register its upgrade listener. injectXrpcSubscription will emit
    // 'upgrade' directly on this server. No port binding.
    const adonisServer = await testUtils.app.container.make('server')
    // Register the dispatch middleware before boot() so the chain has it
    // by the time boot() walks the routes registry.
    adonisServer.use([() => import('../src/middleware/dispatch.js')])
    await adonisServer.boot()
    const nodeServer = createServer(adonisServer.handle.bind(adonisServer))
    adonisServer.setNodeServer(nodeServer)
  })

  const terminate = async () => {
    await testUtils.app.terminate()
  }

  getActiveTest()?.cleanup(terminate)

  return { testUtils, app: testUtils.app, terminate }
}

async function createTestUtilsForEnv(ignitor: any, environment: AppEnvironments) {
  const { TestUtils } = await import('@adonisjs/core/test_utils')
  const app = ignitor.createApp(environment)
  return new TestUtils(app)
}
