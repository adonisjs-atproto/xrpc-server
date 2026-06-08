import { test } from '@japa/runner'
import { parse } from '@atcute/lexicons/validations'

import { setupApp } from './helpers.js'
import { type InjectedXrpcSubscription, injectXrpcSubscription } from '../src/test_utils.js'
import {
  CONTROLLER_STREAM,
  STREAM,
  StreamController,
  tick,
  tickSchema,
} from './fixtures/lexicons.js'

async function* StreamFn() {
  for (let n = 1; n <= 3; n++) {
    yield { $type: tick, value: n }
  }
}

async function parseStream(stream: InjectedXrpcSubscription) {
  const received: number[] = []
  const errors = []
  for await (const frame of stream.messages()) {
    if (frame.type === 'error') {
      errors.push(frame)
    } else {
      let body = parse(tickSchema, frame.body)
      received.push(body.value)
    }
    if (received.length === 3) break
  }
  await stream.close()

  return { received, errors }
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
          router.xrpc.subscription(STREAM, StreamFn)
          router.xrpc.subscription(CONTROLLER_STREAM, [StreamController, 'subscribe'])
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

    const stream = await injectXrpcSubscription(nodeServer, STREAM)
    const { received, errors } = await parseStream(stream)

    assert.empty(errors)
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
    const { received, errors } = await parseStream(stream)

    assert.empty(errors)
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

    // Expected: sibling writes a non-101 response and destroys the socket,
    // so injectWS rejects. assert.rejects awaits the returned Promise — using
    // assert.throws here is a no-op because the promise rejection happens on
    // a future tick, not synchronously when the async fn is invoked.
    await assert.rejects(() => injectWS(nodeServer, '/_vite/hmr'))
    assert.isTrue(sawSiblingUpgrade, 'sibling /_vite/hmr listener should have seen the upgrade')
  })
})
