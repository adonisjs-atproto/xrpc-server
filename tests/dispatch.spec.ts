import { test } from '@japa/runner'
import inject from 'light-my-request'

import { setupApp } from './helpers.js'
import { ECHO_QUERY, PING } from './fixtures/lexicons.js'
import type { XrpcHttpContext } from '../src/context/http.ts'

test.group('dispatch — HTTP procedure + query end-to-end', (group) => {
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
          // Register XRPC routes via the provider-installed router.xrpc getter.
          // The provider's ready() (which fires after this) commits the
          // XrpcRouter and starts the XrpcServer.
          const router = await testApp.container.make('router')
          router.xrpc.procedure(PING, () => ({ pong: true }))
          router.xrpc.query(ECHO_QUERY, (xrpcCtx: XrpcHttpContext<typeof ECHO_QUERY>) => ({
            echoed: xrpcCtx.params.msg,
          }))

          // Register a non-XRPC Adonis route so the fall-through test below
          // can prove the dispatch middleware called next() rather than just
          // observing a default 404.
          router.get('/healthz', () => ({ status: 'ok' })).as('healthz')
          router.commit()
        },
      }
    )
    app = ctx.app
  })

  test('POST /xrpc/com.example.ping returns the handler result as JSON', async ({ assert }) => {
    const server = await app.container.make('server')
    await server.boot()
    const response = await inject(server.handle.bind(server))
      .post('/xrpc/com.example.ping')
      .headers({ 'content-type': 'application/json' })
      .payload(JSON.stringify({}))
    assert.equal(response.statusCode, 200, `response body: ${response.payload}`)
    assert.deepEqual(JSON.parse(response.payload), { pong: true })
  })

  test('GET /xrpc/com.example.echo?msg=hello returns the typed query response', async ({
    assert,
  }) => {
    const server = await app.container.make('server')
    await server.boot()
    const response = await inject(server.handle.bind(server)).get(
      '/xrpc/com.example.echo?msg=hello'
    )
    assert.equal(response.statusCode, 200, `response body: ${response.payload}`)
    assert.deepEqual(JSON.parse(response.payload), { echoed: 'hello' })
  })

  test('GET /xrpc/com.example.notRegistered returns a structured 404 NotFound', async ({
    assert,
  }) => {
    const server = await app.container.make('server')
    await server.boot()
    const response = await inject(server.handle.bind(server), {
      headers: { Accept: 'application/json' },
    }).get('/xrpc/com.example.notRegistered')
    // Our provider wires atcute's handleNotFound hook to reformat the
    // unregistered-NSID response from atcute's default plain-text 'Not
    // Found' into the XRPC error wire shape. 404 NotFound is consistent
    // with the atproto reference server's spec quote for "server does not
    // support this endpoint."
    assert.equal(response.statusCode, 404, `response body: ${response.payload}`)
    assert.deepEqual(JSON.parse(response.payload), {
      error: 'NotFound',
      message: "Method 'com.example.notRegistered' not found on this server",
    })
  })

  test('non-/xrpc/* paths fall through the dispatch middleware to an Adonis route', async ({
    assert,
  }) => {
    const server = await app.container.make('server')
    await server.boot()
    const response = await inject(server.handle.bind(server)).get('/healthz')
    assert.equal(response.statusCode, 200)
    assert.deepEqual(JSON.parse(response.payload), { status: 'ok' })
  })
})
