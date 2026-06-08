import { test } from '@japa/runner'
import { AsyncLocalStorage } from 'node:async_hooks'
import { HttpContextFactory } from '@adonisjs/core/factories/http'

import { XrpcServer } from '../src/xrpc_server.js'
import {
  fromHttpContext,
  requestContextStore,
  type RequestContext,
} from '../src/request_context.js'
import { XrpcSerializer } from '../src/serializer.js'
import { XrpcSubscriptionContext } from '../src/context/main.js'
import { InvalidRequestError, InternalServerError } from '../src/errors.js'
import { XrpcRouter, type RouteInfo } from '../src/router/main.ts'
import { XrpcService, REPORTED } from '../src/xrpc_service.js'
import { ExceptionHandler } from '../src/exception_handler.js'
import { setupApp } from './helpers.js'
import { createXrpcExecutor } from '../src/executor.ts'

// --- shared lexicons ------------------------------------------------------

const PING = { nsid: 'com.example.ping', type: 'xrpc_procedure' } as any
const STREAM = { nsid: 'com.example.stream', type: 'xrpc_subscription' } as any

// --- helpers --------------------------------------------------------------

/**
 * Stub XrpcService with no factory registered — getRegisteredErrorHandler()
 * returns null, falling back to the Plan 03-style InternalServerError wrap.
 * Used by tests that don't exercise error-reporting behavior.
 */
const noOpXrpc = new XrpcService({} as any)

/** Build an executor with a single registered route. */
function makeExecutor(lexicon: any, handler: RouteInfo['handler'], xrpc = noOpXrpc) {
  return createXrpcExecutor({
    operations: new Map([[lexicon.nsid, { lexicon, handler }]]),
    serializer: new XrpcSerializer(),
    xrpc,
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

/**
 * Runtime guards that narrow the executor's union return type while
 * surfacing a clear error if the branch was wrong (better than a silent
 * `as Response` cast hiding a regression).
 */
function ensureResponse(value: unknown): Response {
  if (!(value instanceof Response)) {
    throw new Error(`expected Response, got ${Object.prototype.toString.call(value)}`)
  }
  return value
}
function ensureAsyncIterable<T>(value: unknown): AsyncIterable<T> {
  if (typeof (value as any)?.[Symbol.asyncIterator] !== 'function') {
    throw new Error(`expected AsyncIterable, got ${Object.prototype.toString.call(value)}`)
  }
  return value as AsyncIterable<T>
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

    const response = ensureResponse(
      await executor(
        atcuteHttpCtx('http://localhost/xrpc/com.example.ping', {
          method: 'POST',
          body: JSON.stringify({}),
          headers: { 'content-type': 'application/json' },
        }),
        requestCtx
      )
    )

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

    const response = ensureResponse(
      await executor(
        atcuteHttpCtx('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
        makeRequestCtx()
      )
    )

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

    const response = ensureResponse(
      await executor(
        atcuteHttpCtx('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
        makeRequestCtx()
      )
    )

    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), 'https://cdn.example/blob/abc')
  })

  test('wraps a non-XrpcError as InternalServerError', async ({ assert }) => {
    const executor = executorWithFn(PING, () => {
      throw new Error('boom from handler')
    })
    const atcuteCtx = atcuteHttpCtx('http://localhost/xrpc/com.example.ping', { method: 'POST' })
    const requestCtx = makeRequestCtx()

    await assert.rejects(
      async () => executor(atcuteCtx, requestCtx),
      InternalServerError,
      /boom from handler/
    )
  })

  test('wraps a non-Error throw (string, object, etc.) using String() coercion', async ({
    assert,
  }) => {
    // JS lets handlers throw any value (not just Error instances). The
    // fallback path in runConsumerHandler falls back to String(err) for
    // these — covering throw-a-string is enough to exercise the branch.
    // assert.rejects matching the regex proves both that the executor
    // catches the non-Error throw and that String(err) produced a
    // recognizable message.
    const executor = executorWithFn(PING, () => {
      throw 'plain string thrown by handler'
    })
    const atcuteCtx = atcuteHttpCtx('http://localhost/xrpc/com.example.ping', { method: 'POST' })
    const requestCtx = makeRequestCtx()

    await assert.rejects(
      async () => executor(atcuteCtx, requestCtx),
      InternalServerError,
      /plain string thrown by handler/
    )
  })

  test('passes XrpcError through without re-wrapping', async ({ assert }) => {
    const executor = executorWithFn(PING, () => {
      throw new InvalidRequestError('reason unrecognized')
    })

    await assert.rejects(
      async () => {
        await executor(
          atcuteHttpCtx('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
          makeRequestCtx()
        )
      },
      InvalidRequestError,
      /reason unrecognized/
    )
  })

  test('throws InternalServerError when invoked for an unregistered NSID (defense-in-depth)', async ({
    assert,
  }) => {
    // Atcute's handleNotFound hook (wired in providers/provider.ts)
    // intercepts unregistered NSIDs before the executor — so in normal
    // operation this branch never fires. The test invokes the executor
    // directly (no atcute), exercising the type-narrowing-driven defensive
    // branch. Treating it as InternalServerError reflects the real
    // diagnosis if it ever DOES fire in production: atcute's registry is
    // out of sync with the executor's operations map, which is a server
    // bug, not a client error.
    const executor = createXrpcExecutor({
      operations: new Map(),
      serializer: new XrpcSerializer(),
      xrpc: noOpXrpc,
    })

    await assert.rejects(
      async () => {
        await executor(
          atcuteHttpCtx('http://localhost/xrpc/com.example.unknown', { method: 'POST' }),
          makeRequestCtx()
        )
      },
      InternalServerError,
      /unregistered nsid 'com\.example\.unknown'/i
    )
  })

  test('crafted `/xrpc/__proto__` gets InternalServerError, not a prototype-lookup hit', async ({
    assert,
  }) => {
    // Map-backed ops: Map.get('__proto__') → undefined cleanly. Object lookup
    // would have returned Object.prototype (truthy) and crashed downstream.
    // The error is InternalServerError (defense-in-depth), not the
    // user-facing 'NotFound' shape — atcute's handleNotFound would have
    // produced that before the executor saw the request.
    const executor = createXrpcExecutor({
      operations: new Map(),
      serializer: new XrpcSerializer(),
      xrpc: noOpXrpc,
    })

    await assert.rejects(async () => {
      await executor(
        atcuteHttpCtx('http://localhost/xrpc/__proto__', { method: 'POST' }),
        makeRequestCtx()
      )
    }, InternalServerError)
  })

  test('throws InternalServerError when invoked without a RequestContext', async ({ assert }) => {
    const executor = executorWithFn(PING, () => ({ ok: true }))

    await assert.rejects(
      async () => {
        await executor(atcuteHttpCtx('http://localhost/xrpc/com.example.ping', { method: 'POST' }))
      },
      InternalServerError,
      /without a RequestContext/i
    )
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

    const iterable = ensureAsyncIterable<any>(
      await executor(atcuteSubCtx('http://localhost/xrpc/com.example.stream'), makeRequestCtx())
    )
    const collected = await Array.fromAsync(iterable)

    assert.lengthOf(collected, 3)
    assert.equal(collected[0].n, 1)
    assert.equal(collected[2].n, 3)
  })

  test('XrpcOperationContext.als is in scope during each yielded value (per-.next() ALS re-entry)', async ({
    assert,
  }) => {
    // Regression test for: async generators capture ALS at .next() time, NOT
    // at construction. A one-shot als.run around iterator construction would
    // leave subsequent yields with no store.
    const observed: { nsid: string | undefined }[] = []
    const executor = executorWithFn(STREAM, async function* () {
      for (let n = 1; n <= 3; n++) {
        const fromAls = XrpcSubscriptionContext.get()
        observed.push({ nsid: fromAls?.lexicon.nsid })
        yield { $type: 'com.example.stream#tick', n }
      }
    })

    const iterable = ensureAsyncIterable<any>(
      await executor(atcuteSubCtx('http://localhost/xrpc/com.example.stream'), makeRequestCtx())
    )
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
    const iterable = ensureAsyncIterable<any>(
      await executor(atcuteSubCtx('http://localhost/xrpc/com.example.stream'), makeRequestCtx())
    )
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

// --- runConsumerHandler (error-reporting) --------------------------------

test.group('createXrpcExecutor — error reporting', (group) => {
  group.each.setup(async () => {
    await setupApp()
  })

  test('procedure handler error: report() fires + handle()-returned XrpcError is thrown', async ({
    assert,
  }) => {
    const { app } = await setupApp()

    const reportCalls: unknown[] = []
    const handleReturn = new InvalidRequestError('sanitized by handler')

    class TestHandler extends ExceptionHandler {
      override async report(err: unknown) {
        reportCalls.push(err)
      }
      override async handle(_err: unknown) {
        return handleReturn
      }
    }

    const xrpc = new XrpcService(app)
    xrpc.errorHandler(() => Promise.resolve({ default: TestHandler }))

    const executor = makeExecutor(
      PING,
      {
        kind: 'function',
        fn: () => {
          throw new Error('raw error')
        },
      },
      xrpc
    )

    try {
      await executor(
        atcuteHttpCtx('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
        makeRequestCtx()
      )
      assert.fail('executor should have thrown')
    } catch (err: any) {
      assert.strictEqual(err, handleReturn, 'thrown error is the one handle() returned')
      assert.isTrue((err as any)[REPORTED], 'REPORTED symbol is stamped')
      assert.lengthOf(reportCalls, 1, 'report() was called once')
      assert.instanceOf(reportCalls[0], Error)
      assert.match((reportCalls[0] as Error).message, /raw error/)
    }
  })

  test('subscription handler error: report() fires + XRPCSubscriptionError wraps sanitized error', async ({
    assert,
  }) => {
    const { XRPCSubscriptionError } = await import('@atcute/xrpc-server')
    const { app } = await setupApp()

    const reportCalls: unknown[] = []
    const handleReturn = new InvalidRequestError('sanitized for subscription')

    class TestHandler extends ExceptionHandler {
      override async report(err: unknown) {
        reportCalls.push(err)
      }
      override async handle(_err: unknown) {
        return handleReturn
      }
    }

    const xrpc = new XrpcService(app)
    xrpc.errorHandler(() => Promise.resolve({ default: TestHandler }))

    const executor = makeExecutor(
      STREAM,
      {
        kind: 'function',
        fn: async function* () {
          yield { $type: 'com.example.stream#tick', n: 1 }
          throw new Error('subscription exploded')
        },
      },
      xrpc
    )

    const iterable = ensureAsyncIterable<any>(
      await executor(atcuteSubCtx('http://localhost/xrpc/com.example.stream'), makeRequestCtx())
    )
    let thrown: unknown = null
    try {
      for await (const frame of iterable) {
        void frame // drain
      }
    } catch (err) {
      thrown = err
    }

    assert.instanceOf(thrown, XRPCSubscriptionError)
    assert.equal((thrown as any).error, handleReturn.errorName)
    assert.match((thrown as any).message, /sanitized for subscription/)
    assert.lengthOf(reportCalls, 1, 'report() was called once')
    assert.instanceOf(reportCalls[0], Error)
    assert.match((reportCalls[0] as Error).message, /subscription exploded/)
  })

  test('falls back to InternalServerError wrap when no handler is registered', async ({
    assert,
  }) => {
    // noOpXrpc has no factory — getRegisteredErrorHandler() returns null.
    const executor = makeExecutor(PING, {
      kind: 'function',
      fn: () => {
        throw new Error('unhandled error')
      },
    })

    try {
      await executor(
        atcuteHttpCtx('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
        makeRequestCtx()
      )
      assert.fail('executor should have thrown')
    } catch (err: any) {
      assert.instanceOf(err, InternalServerError)
      assert.match(err.message, /unhandled error/)
      assert.instanceOf(err.cause, Error)
      assert.isTrue((err as any)[REPORTED])
    }
  })

  test('reporter throw does not mask the sanitized error', async ({ assert }) => {
    const { app } = await setupApp()

    const handleReturn = new InvalidRequestError('sanitized despite reporter crash')

    class ThrowingReporter extends ExceptionHandler {
      override async report() {
        throw new Error('Sentry network failure')
      }
      override async handle(_err: unknown) {
        return handleReturn
      }
    }

    const xrpc = new XrpcService(app)
    xrpc.errorHandler(() => Promise.resolve({ default: ThrowingReporter }))

    const executor = makeExecutor(
      PING,
      {
        kind: 'function',
        fn: () => {
          throw new Error('original error')
        },
      },
      xrpc
    )

    try {
      await executor(
        atcuteHttpCtx('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
        makeRequestCtx()
      )
      assert.fail('executor should have thrown')
    } catch (err: any) {
      // The reporter's exception must NOT mask handle()'s return value.
      assert.strictEqual(err, handleReturn)
      assert.isTrue((err as any)[REPORTED])
    }
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
