import { test } from '@japa/runner'
import { setupApp } from './helpers.js'
import { XrpcServer } from '../src/xrpc_server.js'
import { XrpcRouter } from '../src/router/main.ts'
import { XrpcService } from '../src/xrpc_service.js'

test.group('XrpcProvider', () => {
  test('boot() installs the `router.xrpc` getter', async ({ assert }) => {
    const { app } = await setupApp({
      rcFileContents: {
        providers: [() => import('../providers/provider.js')],
      },
    })
    const router = await app.container.make('router')
    assert.instanceOf(router.xrpc, XrpcRouter)
  })

  test('start() commits the XrpcRouter; ready() constructs XrpcServer and calls its start()', async ({
    assert,
  }) => {
    const { app } = await setupApp(
      {
        rcFileContents: {
          providers: [() => import('../providers/provider.js')],
        },
      },
      {
        beforeReady: async (testApp) => {
          // Register a route so commit() (in provider.start(), which fires
          // between preloads and ready()) seals a non-empty registry.
          const router = await testApp.container.make('router')
          router.xrpc.procedure(
            { nsid: 'com.example.ping', type: 'xrpc_procedure' } as any,
            () => ({ pong: true })
          )
        },
      }
    )

    const router = await app.container.make('router')
    assert.isTrue(
      router.xrpc.committed,
      'XrpcRouter should be committed by provider.start() (which runs before ready)'
    )

    const xrpcServer = await app.container.make(XrpcServer)
    assert.instanceOf(xrpcServer, XrpcServer)
  })

  test('start() commits in all environments; ready() skips XrpcServer wiring in console env', async ({
    assert,
  }) => {
    const { app } = await setupApp(
      {
        environment: 'console',
        rcFileContents: {
          providers: [() => import('../providers/provider.js')],
        },
      },
      {
        beforeReady: async (testApp) => {
          const router = await testApp.container.make('router')
          router.xrpc.procedure(
            { nsid: 'com.example.ping', type: 'xrpc_procedure' } as any,
            () => ({ pong: true })
          )
        },
      }
    )

    const router = await app.container.make('router')
    assert.isTrue(
      router.xrpc.committed,
      'start() should have committed the XrpcRouter regardless of env'
    )

    // ready() is gated on env !== 'console', so XrpcServer is not bound in
    // console env. Use `hasBinding` rather than `container.make(XrpcServer)`
    // because the latter would try to auto-construct via @adonisjs/fold and
    // fail with a confusing "cannot resolve" error.
    assert.isFalse(
      app.container.hasBinding(XrpcServer),
      'ready() should not have constructed/bound XrpcServer in console env'
    )
  })

  test('register() binds XrpcService as a container singleton', async ({ assert }) => {
    const { app } = await setupApp({
      rcFileContents: {
        providers: [() => import('../providers/provider.js')],
      },
    })

    const xrpc = await app.container.make('xrpc')
    assert.instanceOf(xrpc, XrpcService)

    const xrpc2 = await app.container.make('xrpc')
    assert.strictEqual(xrpc, xrpc2, 'singleton — same instance on repeated resolution')
  })
})
