import { test } from '@japa/runner'
import { AsyncLocalStorage } from 'node:async_hooks'
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import { XrpcServer, createXrpcExecutor } from '../src/xrpc_server.js'
import { fromHttpContext, requestContextStore, type RequestContext } from '../src/request_context.js'
import { XrpcSerializer } from '../src/serializer.js'
import { setupApp } from './helpers.js'

test.group('dispatch module exports', () => {
  test('xrpc_server.ts exports XrpcServer class + createXrpcExecutor factory', ({ assert }) => {
    assert.isFunction(XrpcServer, 'XrpcServer should be a class (function)')
    assert.isFunction(createXrpcExecutor, 'createXrpcExecutor should be a function')
  })

  test('request_context.ts exports requestContextStore ALS + fromHttpContext helper', ({
    assert,
  }) => {
    assert.isFunction(fromHttpContext, 'fromHttpContext should be a function')
    assert.instanceOf(requestContextStore, AsyncLocalStorage)
  })
})

// A minimal procedure lexicon for the executor tests. Tests in this file
// don't need a real atproto lexicon — we exercise the executor's dispatch
// shape, not lexicon validation (atcute does that before invoking us).
const PING_LEXICON = {
  id: 'com.example.ping',
  type: 'xrpc_procedure',
  defs: { main: { type: 'procedure', input: {}, output: {} } },
} as const

// Construct a RequestContext the same way the HTTP-path dispatch
// middleware does — `fromHttpContext(httpCtx)`. This exercises the real
// materialization helper end-to-end, catching shape drift if `HttpContext`'s
// API moves.
function makeRequestCtx(): RequestContext {
  return fromHttpContext(new HttpContextFactory().create())
}

test.group('createXrpcExecutor — HTTP procedure path', (group) => {
  group.each.setup(async () => {
    await setupApp()
  })

  test('invokes an inline handler and serializes its return value', async ({ assert }) => {
    let invocations = 0
    const executor = createXrpcExecutor({
      operations: new Map([
        [
          PING_LEXICON.id,
          {
            lexicon: PING_LEXICON as any,
            // Already-normalized form. In real registration, XrpcRouter.#register
            // would wrap the inline fn into this shape automatically — the test
            // bypasses the router and constructs RouteInfo directly.
            handler: {
              kind: 'function' as const,
              fn: (ctx: any) => {
                invocations++
                return { pong: true, requestId: ctx.requestId }
              },
            },
          },
        ],
      ]),
      serializer: new XrpcSerializer(),
    })

    const requestCtx = makeRequestCtx()
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.ping', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      }),
      input: {},
      params: {},
      signal: new AbortController().signal,
    }

    const response = (await executor(atcuteCtx, requestCtx)) as Response

    assert.equal(invocations, 1, 'inline handler called exactly once')
    assert.instanceOf(response, Response)
    assert.equal(response.status, 200, 'default status is 200 when handler does not set one')
    assert.equal(response.headers.get('content-type'), 'application/json')
    const body = await response.json()
    assert.deepEqual(body, { pong: true, requestId: requestCtx.requestId })
  })

  test('honors status / header / json overrides set via ctx.response', async ({ assert }) => {
    const executor = createXrpcExecutor({
      operations: new Map([
        [
          PING_LEXICON.id,
          {
            lexicon: PING_LEXICON as any,
            handler: {
              kind: 'function' as const,
              fn: (ctx: any) => {
                ctx.response.status(201).header('etag', 'W/"abc"').json({ created: true })
                // handler returns undefined — explicit json() override is what
                // the executor uses as the body
              },
            },
          },
        ],
      ]),
      serializer: new XrpcSerializer(),
    })

    const requestCtx = makeRequestCtx()
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
      input: {},
      params: {},
      signal: new AbortController().signal,
    }

    const response = (await executor(atcuteCtx, requestCtx)) as Response

    assert.equal(response.status, 201)
    assert.equal(response.headers.get('etag'), 'W/"abc"')
    assert.deepEqual(await response.json(), { created: true })
  })

  test('redirect via ctx.response.redirect(url, status) returns a 3xx Response', async ({
    assert,
  }) => {
    const executor = createXrpcExecutor({
      operations: new Map([
        [
          PING_LEXICON.id,
          {
            lexicon: PING_LEXICON as any,
            handler: {
              kind: 'function' as const,
              fn: (ctx: any) => ctx.response.redirect('https://cdn.example/blob/abc', 302),
            },
          },
        ],
      ]),
      serializer: new XrpcSerializer(),
    })

    const requestCtx = makeRequestCtx()
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
      input: {},
      params: {},
      signal: new AbortController().signal,
    }

    const response = (await executor(atcuteCtx, requestCtx)) as Response

    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), 'https://cdn.example/blob/abc')
  })

  test('wraps a non-XrpcError as InternalServerError', async ({ assert }) => {
    const executor = createXrpcExecutor({
      operations: new Map([
        [
          PING_LEXICON.id,
          {
            lexicon: PING_LEXICON as any,
            handler: {
              kind: 'function' as const,
              fn: () => {
                throw new Error('boom from handler')
              },
            },
          },
        ],
      ]),
      serializer: new XrpcSerializer(),
    })

    const requestCtx = makeRequestCtx()
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
      input: {},
      params: {},
      signal: new AbortController().signal,
    }

    await assert.rejects(async () => executor(atcuteCtx, requestCtx), /boom from handler/)
    // And the rejection should be InternalServerError (status 500, errorName InternalServerError)
    try {
      await executor(atcuteCtx, requestCtx)
    } catch (err: any) {
      assert.equal(err.constructor.name, 'InternalServerError')
      assert.equal(err.errorName, 'InternalServerError')
    }
  })

  test('passes XrpcError through without re-wrapping', async ({ assert }) => {
    const { InvalidRequestError } = await import('../src/errors.js')
    const executor = createXrpcExecutor({
      operations: new Map([
        [
          PING_LEXICON.id,
          {
            lexicon: PING_LEXICON as any,
            handler: {
              kind: 'function' as const,
              fn: () => {
                throw new InvalidRequestError('reason unrecognized')
              },
            },
          },
        ],
      ]),
      serializer: new XrpcSerializer(),
    })

    const requestCtx = makeRequestCtx()
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
      input: {},
      params: {},
      signal: new AbortController().signal,
    }

    try {
      await executor(atcuteCtx, requestCtx)
      assert.fail('executor should have thrown')
    } catch (err: any) {
      assert.equal(err.constructor.name, 'InvalidRequestError')
      assert.equal(err.errorName, 'InvalidRequest')
    }
  })

  test('throws NotFoundError when no route matches the NSID', async ({ assert }) => {
    const executor = createXrpcExecutor({
      operations: new Map(), // no routes
      serializer: new XrpcSerializer(),
    })

    const requestCtx = makeRequestCtx()
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.unknown', { method: 'POST' }),
      input: {},
      params: {},
      signal: new AbortController().signal,
    }

    try {
      await executor(atcuteCtx, requestCtx)
      assert.fail('executor should have thrown')
    } catch (err: any) {
      assert.equal(err.constructor.name, 'NotFoundError')
      assert.equal(err.errorName, 'NotFound')
      assert.match(err.message, /no xrpc method registered/i)
    }
  })

  test('crafted `/xrpc/__proto__` request gets NotFoundError, not a prototype-lookup hit', async ({
    assert,
  }) => {
    // The Map-backed operations is what makes this safe — Map.get('__proto__')
    // returns undefined cleanly, where obj['__proto__'] would have returned
    // Object.prototype (truthy, would have bypassed the `if (!route)` guard
    // and then crashed on `route.lexicon.type` with a confusing TypeError).
    const executor = createXrpcExecutor({
      operations: new Map(),
      serializer: new XrpcSerializer(),
    })
    const requestCtx = makeRequestCtx()
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/__proto__', { method: 'POST' }),
      input: {},
      params: {},
      signal: new AbortController().signal,
    }
    try {
      await executor(atcuteCtx, requestCtx)
      assert.fail('executor should have thrown')
    } catch (err: any) {
      assert.equal(err.constructor.name, 'NotFoundError')
    }
  })

  test('throws InternalServerError when invoked without a RequestContext', async ({ assert }) => {
    // The registered atcute closure passes `requestContextStore.getStore()`
    // through unconditionally. If a dispatch boundary ever fails to populate
    // the store, the executor's optional parameter is undefined and the
    // executor surfaces a precise diagnostic. This test pins that contract.
    const executor = createXrpcExecutor({
      operations: new Map([
        [
          PING_LEXICON.id,
          {
            lexicon: PING_LEXICON as any,
            handler: { kind: 'function' as const, fn: () => ({ ok: true }) },
          },
        ],
      ]),
      serializer: new XrpcSerializer(),
    })
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
      input: {},
      params: {},
      signal: new AbortController().signal,
    }

    try {
      await executor(atcuteCtx) // second arg omitted on purpose
      assert.fail('executor should have thrown')
    } catch (err: any) {
      assert.equal(err.constructor.name, 'InternalServerError')
      assert.match(err.message, /without a RequestContext/i)
    }
  })
})

test.group('XrpcServer.#installRoutes', (group) => {
  let app: any
  group.each.setup(async () => {
    const ctx = await setupApp()
    app = ctx.app
  })

  test('refuses to install routes if the XrpcRouter builder is not committed', async ({
    assert,
  }) => {
    const { XrpcRouter } = await import('../src/router/index.js')
    const xrpc = new XrpcRouter(app)
    xrpc.procedure(
      { nsid: 'com.example.ping', type: 'xrpc_procedure' } as any,
      () => ({ ok: true })
    )
    // Note: NOT calling xrpc.commit()

    const mockAtcuteRouter = makeMockAtcuteRouter()
    const mockWs = makeMockWs()
    const xrpcServer = new XrpcServer({
      app,
      router: mockAtcuteRouter as any,
      ws: mockWs as any,
      executor: (() => undefined) as any,
    })

    // Calling the private method indirectly via start() — but start() also
    // does container.make('router'), which requires the router getter to be
    // installed by the provider (Plan 04). For this test, we exercise the
    // route-install logic in isolation via a test-only escape hatch.
    assert.throws(
      () => (xrpcServer as any).installRoutesForTesting(xrpc),
      /must be committed/
    )
  })

  test('dispatches procedure/query/subscription to the matching atcute add* method', async ({
    assert,
  }) => {
    const { XrpcRouter } = await import('../src/router/index.js')
    const PROC = { nsid: 'com.example.proc', type: 'xrpc_procedure' } as const
    const QUERY = { nsid: 'com.example.query', type: 'xrpc_query' } as const
    const SUB = { nsid: 'com.example.sub', type: 'xrpc_subscription' } as const

    const xrpc = new XrpcRouter(app)
    xrpc.procedure(PROC as any, () => ({ ok: true }))
    xrpc.query(QUERY as any, () => ({ ok: true }))
    xrpc.subscription(SUB as any, async function* () {
      yield {}
    })
    xrpc.commit()

    const mockAtcuteRouter = makeMockAtcuteRouter()
    const mockWs = makeMockWs()
    const xrpcServer = new XrpcServer({
      app,
      router: mockAtcuteRouter as any,
      ws: mockWs as any,
      executor: (() => undefined) as any,
    })

    ;(xrpcServer as any).installRoutesForTesting(xrpc)

    assert.lengthOf(mockAtcuteRouter.addProcedureCalls, 1)
    assert.lengthOf(mockAtcuteRouter.addQueryCalls, 1)
    assert.lengthOf(mockAtcuteRouter.addSubscriptionCalls, 1)
    assert.equal(mockAtcuteRouter.addProcedureCalls[0].lexicon.nsid, 'com.example.proc')
    assert.equal(mockAtcuteRouter.addQueryCalls[0].lexicon.nsid, 'com.example.query')
    assert.equal(mockAtcuteRouter.addSubscriptionCalls[0].lexicon.nsid, 'com.example.sub')

    // All three should have received the same handler shape — verifying the
    // closure-deduplication design (single handler closure per server).
    const procHandler = mockAtcuteRouter.addProcedureCalls[0].opts.handler
    const queryHandler = mockAtcuteRouter.addQueryCalls[0].opts.handler
    const subHandler = mockAtcuteRouter.addSubscriptionCalls[0].opts.handler
    assert.strictEqual(procHandler, queryHandler)
    assert.strictEqual(procHandler, subHandler)
  })
})

function makeMockAtcuteRouter() {
  const addProcedureCalls: { lexicon: any; opts: any }[] = []
  const addQueryCalls: { lexicon: any; opts: any }[] = []
  const addSubscriptionCalls: { lexicon: any; opts: any }[] = []
  return {
    addProcedureCalls,
    addQueryCalls,
    addSubscriptionCalls,
    addProcedure(lexicon: any, opts: any) {
      addProcedureCalls.push({ lexicon, opts })
    },
    addQuery(lexicon: any, opts: any) {
      addQueryCalls.push({ lexicon, opts })
    },
    addSubscription(lexicon: any, opts: any) {
      addSubscriptionCalls.push({ lexicon, opts })
    },
  }
}

function makeMockWs() {
  return {
    adapter: {},
    injectWebSocket: () => {},
  }
}

test.group('createXrpcExecutor — subscription path', (group) => {
  group.each.setup(async () => {
    await setupApp()
  })

  const SUB_LEXICON = {
    id: 'com.example.stream',
    nsid: 'com.example.stream',
    type: 'xrpc_subscription',
    defs: {
      main: {
        type: 'subscription',
        message: { schema: { type: 'union', refs: ['#tick'] } },
      },
      tick: { type: 'object', properties: { n: { type: 'integer' } } },
    },
  } as const

  test('wraps an async-generator handler and yields serialized messages', async ({ assert }) => {
    const executor = createXrpcExecutor({
      operations: new Map([
        [
          SUB_LEXICON.id,
          {
            lexicon: SUB_LEXICON as any,
            handler: {
              kind: 'function' as const,
              fn: async function* (_ctx: any) {
                yield { $type: 'com.example.stream#tick', n: 1 }
                yield { $type: 'com.example.stream#tick', n: 2 }
                yield { $type: 'com.example.stream#tick', n: 3 }
              },
            },
          },
        ],
      ]),
      serializer: new XrpcSerializer(),
    })

    const requestCtx = makeRequestCtx()
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.stream'),
      params: {},
      signal: new AbortController().signal,
    }

    const iterable = (await executor(atcuteCtx, requestCtx)) as AsyncIterable<any>
    const collected: any[] = []
    for await (const msg of iterable) {
      collected.push(msg)
    }

    assert.lengthOf(collected, 3)
    assert.equal(collected[0].n, 1)
    assert.equal(collected[2].n, 3)
  })

  test('XrpcContext.als is in scope during each yielded value (per-.next() ALS re-entry)', async ({
    assert,
  }) => {
    // The whole reason wrapSubscriptionIterator takes xrpcCtx as a parameter
    // and wraps each inner .next() in XrpcContext.als.run: async generators
    // capture their ALS context at .next() time, not at construction. If we
    // ever regress to a one-shot als.run around iterator construction, this
    // test fails — the handler body's getOrFail() calls return undefined.
    const { XrpcContext } = await import('../src/context.js')
    const observed: ({ has: true; nsid: string } | { has: false })[] = []
    const executor = createXrpcExecutor({
      operations: new Map([
        [
          SUB_LEXICON.id,
          {
            lexicon: SUB_LEXICON as any,
            handler: {
              kind: 'function' as const,
              fn: async function* (_ctx: any) {
                for (let n = 1; n <= 3; n++) {
                  const fromAls = XrpcContext.als.getStore()
                  observed.push(
                    fromAls ? { has: true, nsid: (fromAls.lexicon as any).id } : { has: false }
                  )
                  yield { $type: 'com.example.stream#tick', n }
                }
              },
            },
          },
        ],
      ]),
      serializer: new XrpcSerializer(),
    })

    const requestCtx = makeRequestCtx()
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.stream'),
      params: {},
      signal: new AbortController().signal,
    }

    const iterable = (await executor(atcuteCtx, requestCtx)) as AsyncIterable<any>
    for await (const _ of iterable) {
      /* drain */
    }

    assert.lengthOf(observed, 3)
    for (const entry of observed) {
      assert.isTrue(entry.has, 'XrpcContext.als.getStore() should be defined on each yield')
      assert.equal((entry as any).nsid, 'com.example.stream')
    }
  })

  test('translates XrpcError thrown from a subscription handler to XRPCSubscriptionError', async ({
    assert,
  }) => {
    const { InvalidRequestError } = await import('../src/errors.js')
    const { XRPCSubscriptionError } = await import('@atcute/xrpc-server')

    const executor = createXrpcExecutor({
      operations: new Map([
        [
          SUB_LEXICON.id,
          {
            lexicon: SUB_LEXICON as any,
            handler: {
              kind: 'function' as const,
              fn: async function* (_ctx: any) {
                yield { $type: 'com.example.stream#tick', n: 1 }
                throw new InvalidRequestError('cursor is from the future')
              },
            },
          },
        ],
      ]),
      serializer: new XrpcSerializer(),
    })

    const requestCtx = makeRequestCtx()

    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.stream'),
      params: {},
      signal: new AbortController().signal,
    }

    const iterable = (await executor(atcuteCtx, requestCtx)) as AsyncIterable<any>
    const collected: any[] = []
    try {
      for await (const msg of iterable) {
        collected.push(msg)
      }
      assert.fail('iterable should have thrown')
    } catch (err: any) {
      assert.instanceOf(err, XRPCSubscriptionError)
      assert.equal(err.error, 'InvalidRequest') // mapped from XrpcError.errorName
      assert.match(err.message, /cursor is from the future/)
    }

    assert.lengthOf(collected, 1, 'first message yielded before the throw')
  })
})
