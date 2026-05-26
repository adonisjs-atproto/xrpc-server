import { test } from '@japa/runner'
import { AsyncLocalStorage } from 'node:async_hooks'
import { HttpContextFactory } from '@adonisjs/core/factories/http'

import { XrpcServer, createXrpcExecutor } from '../src/xrpc_server.js'
import {
  fromHttpContext,
  requestContextStore,
  type RequestContext,
} from '../src/request_context.js'
import { XrpcSerializer } from '../src/serializer.js'
import { XrpcContext } from '../src/context.js'
import { InvalidRequestError } from '../src/errors.js'
import { XrpcRouter, type RouteInfo } from '../src/router/index.js'
import { setupApp } from './helpers.js'

// --- shared lexicons ------------------------------------------------------

const PING = { nsid: 'com.example.ping', type: 'xrpc_procedure' } as any
const STREAM = { nsid: 'com.example.stream', type: 'xrpc_subscription' } as any

// --- helpers --------------------------------------------------------------

/** Build an executor with a single registered route. */
function makeExecutor(lexicon: any, handler: RouteInfo['handler']) {
  return createXrpcExecutor({
    operations: new Map([[lexicon.nsid, { lexicon, handler }]]),
    serializer: new XrpcSerializer(),
  })
}

/** Single-route executor wired to an inline function handler. */
function executorWithFn(lexicon: any, fn: (ctx: any) => any) {
  return makeExecutor(lexicon, { kind: 'function', fn })
}

/** Minimal `atcuteCtx` shape for HTTP procedure/query paths. */
function atcuteHttpCtx(url: string, init?: RequestInit) {
  return {
    request: new Request(url, init),
    input: {},
    params: {},
    signal: new AbortController().signal,
  }
}

/** Minimal `atcuteCtx` shape for the subscription path (no `input`). */
function atcuteSubCtx(url: string) {
  return {
    request: new Request(url),
    params: {},
    signal: new AbortController().signal,
  }
}

/**
 * Build a RequestContext via the same materialization helper the HTTP
 * dispatch middleware uses, so any drift in HttpContext's surface trips a
 * test before reaching consumer code.
 */
function makeRequestCtx(): RequestContext {
  return fromHttpContext(new HttpContextFactory().create())
}

// --- module-shape tests ---------------------------------------------------

test.group('dispatch module exports', () => {
  test('xrpc_server.ts exports XrpcServer + createXrpcExecutor', ({ assert }) => {
    assert.isFunction(XrpcServer)
    assert.isFunction(createXrpcExecutor)
  })

  test('request_context.ts exports requestContextStore + fromHttpContext', ({ assert }) => {
    assert.isFunction(fromHttpContext)
    assert.instanceOf(requestContextStore, AsyncLocalStorage)
  })
})

// --- HTTP procedure/query path -------------------------------------------

test.group('createXrpcExecutor — HTTP path', (group) => {
  group.each.setup(async () => {
    await setupApp()
  })

  test('invokes an inline handler and serializes its return value', async ({ assert }) => {
    let invocations = 0
    const executor = executorWithFn(PING, (ctx) => {
      invocations++
      return { pong: true, requestId: ctx.requestId }
    })
    const requestCtx = makeRequestCtx()

    const response = (await executor(
      atcuteHttpCtx('http://localhost/xrpc/com.example.ping', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      }),
      requestCtx
    )) as Response

    assert.equal(invocations, 1)
    assert.instanceOf(response, Response)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/json')
    assert.deepEqual(await response.json(), { pong: true, requestId: requestCtx.requestId })
  })

  test('honors status / header / json overrides set via ctx.response', async ({ assert }) => {
    const executor = executorWithFn(PING, (ctx) => {
      ctx.response.status(201).header('etag', 'W/"abc"').json({ created: true })
    })

    const response = (await executor(
      atcuteHttpCtx('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
      makeRequestCtx()
    )) as Response

    assert.equal(response.status, 201)
    assert.equal(response.headers.get('etag'), 'W/"abc"')
    assert.deepEqual(await response.json(), { created: true })
  })

  test('redirect via ctx.response.redirect(url, status) returns a 3xx Response', async ({
    assert,
  }) => {
    const executor = executorWithFn(PING, (ctx) =>
      ctx.response.redirect('https://cdn.example/blob/abc', 302)
    )

    const response = (await executor(
      atcuteHttpCtx('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
      makeRequestCtx()
    )) as Response

    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), 'https://cdn.example/blob/abc')
  })

  test('wraps a non-XrpcError as InternalServerError', async ({ assert }) => {
    const executor = executorWithFn(PING, () => {
      throw new Error('boom from handler')
    })
    const atcuteCtx = atcuteHttpCtx('http://localhost/xrpc/com.example.ping', { method: 'POST' })
    const requestCtx = makeRequestCtx()

    await assert.rejects(async () => executor(atcuteCtx, requestCtx), /boom from handler/)
    try {
      await executor(atcuteCtx, requestCtx)
    } catch (err: any) {
      assert.equal(err.constructor.name, 'InternalServerError')
      assert.equal(err.errorName, 'InternalServerError')
    }
  })

  test('passes XrpcError through without re-wrapping', async ({ assert }) => {
    const executor = executorWithFn(PING, () => {
      throw new InvalidRequestError('reason unrecognized')
    })

    try {
      await executor(
        atcuteHttpCtx('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
        makeRequestCtx()
      )
      assert.fail('executor should have thrown')
    } catch (err: any) {
      assert.equal(err.constructor.name, 'InvalidRequestError')
      assert.equal(err.errorName, 'InvalidRequest')
    }
  })

  test('throws NotFoundError when no route matches the NSID', async ({ assert }) => {
    const executor = createXrpcExecutor({
      operations: new Map(),
      serializer: new XrpcSerializer(),
    })

    try {
      await executor(
        atcuteHttpCtx('http://localhost/xrpc/com.example.unknown', { method: 'POST' }),
        makeRequestCtx()
      )
      assert.fail('executor should have thrown')
    } catch (err: any) {
      assert.equal(err.constructor.name, 'NotFoundError')
      assert.equal(err.errorName, 'NotFound')
      assert.match(err.message, /no xrpc method registered/i)
    }
  })

  test('crafted `/xrpc/__proto__` gets NotFoundError, not a prototype-lookup hit', async ({
    assert,
  }) => {
    // Map-backed ops: Map.get('__proto__') → undefined cleanly. Object lookup
    // would have returned Object.prototype (truthy) and crashed downstream.
    const executor = createXrpcExecutor({
      operations: new Map(),
      serializer: new XrpcSerializer(),
    })

    try {
      await executor(
        atcuteHttpCtx('http://localhost/xrpc/__proto__', { method: 'POST' }),
        makeRequestCtx()
      )
      assert.fail('executor should have thrown')
    } catch (err: any) {
      assert.equal(err.constructor.name, 'NotFoundError')
    }
  })

  test('throws InternalServerError when invoked without a RequestContext', async ({ assert }) => {
    const executor = executorWithFn(PING, () => ({ ok: true }))

    try {
      await executor(atcuteHttpCtx('http://localhost/xrpc/com.example.ping', { method: 'POST' }))
      assert.fail('executor should have thrown')
    } catch (err: any) {
      assert.equal(err.constructor.name, 'InternalServerError')
      assert.match(err.message, /without a RequestContext/i)
    }
  })
})

// --- subscription path ---------------------------------------------------

test.group('createXrpcExecutor — subscription path', (group) => {
  group.each.setup(async () => {
    await setupApp()
  })

  test('wraps an async-generator handler and yields serialized messages', async ({ assert }) => {
    const executor = executorWithFn(STREAM, async function* () {
      yield { $type: 'com.example.stream#tick', n: 1 }
      yield { $type: 'com.example.stream#tick', n: 2 }
      yield { $type: 'com.example.stream#tick', n: 3 }
    })

    const iterable = (await executor(
      atcuteSubCtx('http://localhost/xrpc/com.example.stream'),
      makeRequestCtx()
    )) as AsyncIterable<any>
    const collected = await Array.fromAsync(iterable)

    assert.lengthOf(collected, 3)
    assert.equal(collected[0].n, 1)
    assert.equal(collected[2].n, 3)
  })

  test('XrpcContext.als is in scope during each yielded value (per-.next() ALS re-entry)', async ({
    assert,
  }) => {
    // Regression test for: async generators capture ALS at .next() time, NOT
    // at construction. A one-shot als.run around iterator construction would
    // leave subsequent yields with no store.
    const observed: { nsid: string | undefined }[] = []
    const executor = executorWithFn(STREAM, async function* () {
      for (let n = 1; n <= 3; n++) {
        const fromAls = XrpcContext.als.getStore()
        observed.push({ nsid: (fromAls?.lexicon as any)?.nsid })
        yield { $type: 'com.example.stream#tick', n }
      }
    })

    const iterable = (await executor(
      atcuteSubCtx('http://localhost/xrpc/com.example.stream'),
      makeRequestCtx()
    )) as AsyncIterable<any>
    await Array.fromAsync(iterable)

    assert.lengthOf(observed, 3)
    for (const entry of observed) {
      assert.equal(entry.nsid, 'com.example.stream')
    }
  })

  test('translates XrpcError thrown from a subscription handler to XRPCSubscriptionError', async ({
    assert,
  }) => {
    const { XRPCSubscriptionError } = await import('@atcute/xrpc-server')

    const executor = executorWithFn(STREAM, async function* () {
      yield { $type: 'com.example.stream#tick', n: 1 }
      throw new InvalidRequestError('cursor is from the future')
    })

    // Manual iteration here: we want to inspect what was yielded *before*
    // the throw. `Array.fromAsync` rejects without returning the partial
    // result, so it can't satisfy both assertions in this test.
    const iterable = (await executor(
      atcuteSubCtx('http://localhost/xrpc/com.example.stream'),
      makeRequestCtx()
    )) as AsyncIterable<any>
    const collected: any[] = []
    let thrown: unknown = null
    try {
      for await (const msg of iterable) collected.push(msg)
    } catch (err) {
      thrown = err
    }
    assert.instanceOf(thrown, XRPCSubscriptionError)
    assert.equal((thrown as any).error, 'InvalidRequest')
    assert.match((thrown as any).message, /cursor is from the future/)
    assert.lengthOf(collected, 1)
  })
})

// --- #installRoutes ------------------------------------------------------

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

const mockWs = { adapter: {}, injectWebSocket: () => {} } as any

test.group('XrpcServer.#installRoutes', (group) => {
  let app: any
  group.each.setup(async () => {
    const ctx = await setupApp()
    app = ctx.app
  })

  test('refuses to install routes if the XrpcRouter builder is not committed', async ({
    assert,
  }) => {
    const xrpc = new XrpcRouter(app)
    xrpc.procedure(PING, () => ({ ok: true }))
    // Note: NOT calling xrpc.commit()

    const xrpcServer = new XrpcServer({
      app,
      router: makeMockAtcuteRouter() as any,
      ws: mockWs,
      executor: (() => undefined) as any,
    })

    assert.throws(() => xrpcServer.installRoutesForTesting(xrpc), /must be committed/)
  })

  test('dispatches procedure/query/subscription to the matching atcute add* method', async ({
    assert,
  }) => {
    const PROC = { nsid: 'com.example.proc', type: 'xrpc_procedure' } as any
    const QUERY = { nsid: 'com.example.query', type: 'xrpc_query' } as any
    const SUB = { nsid: 'com.example.sub', type: 'xrpc_subscription' } as any

    const xrpc = new XrpcRouter(app)
    xrpc.procedure(PROC, () => ({ ok: true }))
    xrpc.query(QUERY, () => ({ ok: true }))
    xrpc.subscription(SUB, async function* () {
      yield {}
    })
    xrpc.commit()

    const mockRouter = makeMockAtcuteRouter()
    const xrpcServer = new XrpcServer({
      app,
      router: mockRouter as any,
      ws: mockWs,
      executor: (() => undefined) as any,
    })

    xrpcServer.installRoutesForTesting(xrpc)

    assert.lengthOf(mockRouter.addProcedureCalls, 1)
    assert.lengthOf(mockRouter.addQueryCalls, 1)
    assert.lengthOf(mockRouter.addSubscriptionCalls, 1)
    assert.equal(mockRouter.addProcedureCalls[0].lexicon.nsid, 'com.example.proc')
    assert.equal(mockRouter.addQueryCalls[0].lexicon.nsid, 'com.example.query')
    assert.equal(mockRouter.addSubscriptionCalls[0].lexicon.nsid, 'com.example.sub')

    // Closure-deduplication: all three routes share the same handler instance.
    const procHandler = mockRouter.addProcedureCalls[0].opts.handler
    assert.strictEqual(mockRouter.addQueryCalls[0].opts.handler, procHandler)
    assert.strictEqual(mockRouter.addSubscriptionCalls[0].opts.handler, procHandler)
  })
})
