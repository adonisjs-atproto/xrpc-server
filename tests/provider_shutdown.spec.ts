import { test } from '@japa/runner'
import { subscription, object } from '@atcute/lexicons/validations'

import { setupApp } from './helpers.js'
import { injectXrpcSubscription } from '../src/test_utils.js'
import { XrpcServer } from '../src/xrpc_server.js'

// Reuse the same lexicon shape as dispatch_subscription.spec.ts.
const STREAM = subscription('com.example.stream', {
  params: object({}),
  message: null,
})

test.group('XrpcServer.shutdown() — graceful WS teardown', () => {
  test('sends 1001 close frame to connected subscription clients', async ({ assert }) => {
    const { app } = await setupApp(
      {
        rcFileContents: {
          providers: [() => import('../providers/provider.js')],
        },
      },
      {
        beforeReady: async (testApp) => {
          const router = await testApp.container.make('router')
          router.xrpc.subscription(STREAM as any, async function* () {
            // Infinite subscription — yields forever until the connection closes.
            let n = 0
            while (true) {
              yield { $type: 'com.example.stream#tick', n: ++n }
              await new Promise((resolve) => setTimeout(resolve, 50))
            }
          })
        },
      }
    )

    const adonisServer = await app.container.make('server')
    const nodeServer = adonisServer.getNodeServer()!
    const xrpcServer = await app.container.make(XrpcServer)

    const stream = await injectXrpcSubscription(nodeServer, STREAM as any)
    assert.equal(
      stream.socket.readyState,
      stream.socket.OPEN,
      'socket should be open before shutdown'
    )

    // Capture close event from the client side.
    let closeCode: number | undefined
    const closedPromise = new Promise<void>((resolve) => {
      stream.socket.once('close', (code) => {
        closeCode = code
        resolve()
      })
    })

    // Trigger graceful shutdown.
    await xrpcServer.shutdown()
    await closedPromise

    // 1001 = Going Away (server-initiated graceful close).
    assert.equal(closeCode, 1001, 'client should receive a 1001 close frame')
  })

  test('destroys the socket for upgrade attempts during shutdown', async ({ assert }) => {
    const { app } = await setupApp({
      rcFileContents: {
        providers: [() => import('../providers/provider.js')],
      },
    })

    const adonisServer = await app.container.make('server')
    const nodeServer = adonisServer.getNodeServer()!
    const xrpcServer = await app.container.make(XrpcServer)

    // Shutdown with no active clients — returns immediately but sets
    // #shuttingDown = true.
    await xrpcServer.shutdown()

    // Emit a synthetic upgrade event with a mock socket. Because
    // #upgradeListener is async, its synchronous preamble (the #shuttingDown
    // check + socket.destroy() call) runs before the .emit() returns.
    let socketDestroyed = false
    const mockSocket = {
      destroy() {
        socketDestroyed = true
      },
    }
    nodeServer.emit(
      'upgrade',
      { url: `/xrpc/${STREAM.nsid}`, headers: {} },
      mockSocket,
      Buffer.alloc(0)
    )

    assert.isTrue(socketDestroyed, 'socket should be destroyed synchronously when #shuttingDown')
  })

  test('completes promptly with graceMs=0 even if subscription handler is infinite', async ({
    assert,
  }) => {
    // Verifies that shutdown() does NOT wait for the subscription generator
    // to finish — it terminates clients and returns regardless of handler state.
    // The grace window is 0 so force-terminate fires immediately after sending
    // the close frame, without waiting for acks.
    const { app } = await setupApp(
      {
        rcFileContents: {
          providers: [() => import('../providers/provider.js')],
        },
      },
      {
        beforeReady: async (testApp) => {
          const router = await testApp.container.make('router')
          router.xrpc.subscription(STREAM as any, async function* () {
            // Infinite — ignores close signal.
            while (true) {
              yield { $type: 'com.example.stream#tick', n: 1 }
              await new Promise((resolve) => setTimeout(resolve, 200))
            }
          })
        },
      }
    )

    const adonisServer = await app.container.make('server')
    const nodeServer = adonisServer.getNodeServer()!
    const xrpcServer = await app.container.make(XrpcServer)

    const stream = await injectXrpcSubscription(nodeServer, STREAM as any)

    // shutdown(0) must return promptly despite the infinite handler. If it
    // incorrectly awaited handler completion, this assertion would timeout.
    const start = Date.now()
    await xrpcServer.shutdown(0)
    assert.isBelow(Date.now() - start, 500, 'shutdown(0) should not wait for handler to finish')

    // Cleanup — the stream may or may not have closed yet; ignore errors.
    try {
      await stream.close(1000)
    } catch {}
  })

  test('no-op when no clients are connected', async ({ assert }) => {
    const { app } = await setupApp({
      rcFileContents: {
        providers: [() => import('../providers/provider.js')],
      },
    })

    const xrpcServer = await app.container.make(XrpcServer)

    const start = Date.now()
    await xrpcServer.shutdown()
    const elapsed = Date.now() - start

    assert.isBelow(elapsed, 100, 'shutdown should return promptly when no clients connected')
  })
})
