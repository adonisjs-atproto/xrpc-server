import { test } from '@japa/runner'
import { subscription, object } from '@atcute/lexicons/validations'

import { setupApp } from './helpers.js'
import { injectXrpcSubscription } from '../src/test_utils.js'

// Build the subscription lexicon via atcute's helpers so the `~run`
// fastpath codegen used by atcute's validation is present (a plain
// object literal crashes safeParse — see dispatch.spec.ts comment).
const STREAM = subscription('com.example.stream', {
  params: object({}),
  message: null,
})

// Separate lexicon for the controller-path test so both handlers can be
// registered in the shared beforeEach without colliding on NSID.
const CONTROLLER_STREAM = subscription('com.example.controller-stream', {
  params: object({}),
  message: null,
})

// Defined at module scope: moduleCaller detects classes via
// Function.prototype.toString.call(value).startsWith('class '), which works
// for a top-level class declaration but not for one constructed inline inside
// a test closure (TS may down-emit it to a `var X = class { ... }` form that
// the regex misses).
class StreamController {
  async *subscribe(_ctx: any) {
    for (let n = 1; n <= 3; n++) {
      yield { $type: 'com.example.controller-stream#tick', n }
    }
  }
}

test.group('dispatch — WebSocket subscription end-to-end', (group) => {
  let app: any
  group.each.setup(async () => {
    const ctx = await setupApp(
      {
        rcFileContents: {
          providers: [() => import('../providers/provider.js')],
        },
      },
      {
        beforeReady: async (testApp) => {
          const router = await testApp.container.make('router')
          router.xrpc.subscription(STREAM as any, async function* () {
            for (let n = 1; n <= 3; n++) {
              yield { $type: 'com.example.stream#tick', n }
            }
          })
          router.xrpc.subscription(CONTROLLER_STREAM as any, [StreamController, 'subscribe'])
        },
      }
    )
    app = ctx.app
  })

  test('WebSocket client receives all 3 yielded ticks via injectXrpcSubscription', async ({
    assert,
  }) => {
    const adonisServer = await app.container.make('server')
    const nodeServer = adonisServer.getNodeServer()!

    const stream = await injectXrpcSubscription(nodeServer, STREAM as any)
    const received: number[] = []
    for await (const frame of stream.messages()) {
      if (frame.type === 'message' && (frame.body as any)?.n !== undefined) {
        received.push((frame.body as any).n)
      }
      if (received.length === 3) break
    }
    await stream.close()

    assert.deepEqual(received, [1, 2, 3])
  })

  test('controller-form subscription handler ([Controller, method] tuple) dispatches correctly', async ({
    assert,
  }) => {
    // Regression test: the controller path goes through fold's toHandleMethod,
    // which wraps the method call in an always-async `handle`. Before the
    // executor's invokeHandler was made async + wrapSubscriptionIterator was
    // taught to await the iterable, wrapSubscriptionIterator called
    // [Symbol.asyncIterator]() on the unwrapped Promise<AsyncIterable>
    // (TypeError). Atcute closed the WebSocket immediately and routed the
    // error through our makeSocketErrorObserver (providers/provider.ts),
    // which surfaced it as an InternalServerError via the consumer's
    // ExceptionHandler — clients saw an instant close with no useful data,
    // and the only signal anything went wrong was the ISE in server logs.
    const adonisServer = await app.container.make('server')
    const nodeServer = adonisServer.getNodeServer()!

    const stream = await injectXrpcSubscription(nodeServer, CONTROLLER_STREAM as any)
    const received: number[] = []
    for await (const frame of stream.messages()) {
      if (frame.type === 'message' && (frame.body as any)?.n !== undefined) {
        received.push((frame.body as any).n)
      }
      if (received.length === 3) break
    }
    await stream.close()

    assert.deepEqual(received, [1, 2, 3])
  })

  test('non-XRPC upgrade requests fall through to other listeners (Vite HMR coexistence)', async ({
    assert,
  }) => {
    // Register a sibling 'upgrade' listener that handles a non-XRPC path —
    // simulates Adonis's Vite integration installing its HMR upgrade handler
    // alongside ours. If snip-and-wrap in #installWebSocketHandler regresses
    // (or atcute starts adding multiple listeners), atcute would 404 this
    // upgrade and the sibling never sees it.
    const adonisServer = await app.container.make('server')
    const nodeServer = adonisServer.getNodeServer()!
    let sawSiblingUpgrade = false
    nodeServer.on('upgrade', (req: any, socket: any) => {
      if (req.url === '/_vite/hmr') {
        sawSiblingUpgrade = true
        socket.write('HTTP/1.1 200 OK\r\n\r\n')
        socket.destroy()
      }
    })

    const { injectWS } = await import('light-my-websocket')
    try {
      await injectWS(nodeServer, '/_vite/hmr')
    } catch {
      // Expected: sibling writes a non-101 response and destroys the socket,
      // so injectWS rejects. That's fine — the sibling-saw-it assertion is
      // the actual proof of fall-through.
    }

    assert.isTrue(sawSiblingUpgrade, 'sibling /_vite/hmr listener should have seen the upgrade')
  })
})
