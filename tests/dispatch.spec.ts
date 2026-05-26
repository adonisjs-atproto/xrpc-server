import { test } from '@japa/runner'
import inject from 'light-my-request'
import { object, procedure, query, string } from '@atcute/lexicons/validations'

import { setupApp } from './helpers.js'

// Use atcute's lexicon builders so the schemas have the `~run` fastpath
// codegen atcute's `safeParse` requires. Plain object literals with
// `{ type: 'object', shape: ... }` work for type-checking but crash at
// runtime in `safeParse` (which calls `schema['~run']`).
const PING = procedure('com.example.ping', {
  params: null,
  input: { type: 'lex', schema: object({}) },
  output: null,
})

const ECHO_QUERY = query('com.example.echo', {
  params: object({ msg: string() }),
  output: null,
})

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
          router.xrpc.procedure(PING as any, () => ({ pong: true }))
          router.xrpc.query(ECHO_QUERY as any, (xrpcCtx: any) => ({ echoed: xrpcCtx.params.msg }))

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
