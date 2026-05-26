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
