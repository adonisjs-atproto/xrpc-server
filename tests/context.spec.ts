import { test } from '@japa/runner'
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import { XrpcContext, XrpcResponse, XrpcStream } from '../src/context.js'

const procedureLex = { nsid: 'com.example.test.proc', type: 'xrpc_procedure' } as any
const subscriptionLex = { nsid: 'com.example.test.sub', type: 'xrpc_subscription' } as any

function makeContext(overrides: Partial<ConstructorParameters<typeof XrpcContext>[0]> = {}) {
  const httpCtx = new HttpContextFactory().create()
  const lexicon = (overrides.lexicon as any) ?? procedureLex
  return new XrpcContext({
    lexicon,
    request: httpCtx.request,
    input: undefined,
    params: {},
    signal: new AbortController().signal,
    logger: httpCtx.logger,
    containerResolver: httpCtx.containerResolver,
    requestId: httpCtx.request.id() ?? 'test-req-id',
    ...overrides,
  })
}

test.group('XrpcContext — construction', () => {
  test('exposes the materialized primitives directly', ({ assert }) => {
    const ctx = makeContext()
    assert.isObject(ctx.logger)
    assert.isObject(ctx.containerResolver)
    assert.isString(ctx.requestId)
    assert.isObject(ctx.request)
    assert.isFunction((ctx.request as any).header)
  })

  test('procedure-kind context exposes response as XrpcResponse', ({ assert }) => {
    const ctx = makeContext()
    assert.instanceOf(ctx.response, XrpcResponse)
  })

  test('subscription-kind context exposes response as XrpcStream', ({ assert }) => {
    const ctx = makeContext({ lexicon: subscriptionLex })
    assert.instanceOf(ctx.response, XrpcStream)
  })
})

test.group('XrpcContext.get / .getOrFail — ALS', () => {
  test('get() returns undefined outside any als.run scope', ({ assert }) => {
    assert.isUndefined(XrpcContext.get())
  })

  test('getOrFail() throws outside any als.run scope', ({ assert }) => {
    assert.throws(() => XrpcContext.getOrFail(), /XrpcContext is not available/)
  })

  test('get() and getOrFail() both return the active context inside an als.run scope', async ({
    assert,
  }) => {
    const ctx = makeContext()
    await XrpcContext.als.run(ctx, async () => {
      assert.equal(XrpcContext.get(), ctx)
      assert.equal(XrpcContext.getOrFail(), ctx)
      await new Promise((r) => setImmediate(r))
      assert.equal(XrpcContext.get(), ctx)
      assert.equal(XrpcContext.getOrFail(), ctx)
    })
  })

  test('nested als.run scopes shadow the outer context', async ({ assert }) => {
    const outer = makeContext()
    const inner = makeContext()
    await XrpcContext.als.run(outer, async () => {
      assert.equal(XrpcContext.getOrFail(), outer)
      await XrpcContext.als.run(inner, async () => {
        assert.equal(XrpcContext.getOrFail(), inner)
      })
      assert.equal(XrpcContext.getOrFail(), outer)
    })
  })
})

test.group('XrpcResponse — chainable setters', () => {
  test('status / header mutate internal state and return this', ({ assert }) => {
    const ctx = makeContext()
    const response = ctx.response as XrpcResponse<any>
    const ret = response.status(201).header('etag', 'abc')
    assert.equal(ret, ctx.response, 'chain returns itself')
    assert.equal((ctx.response as XrpcResponse<any>).state.status, 201)
    assert.equal((ctx.response as XrpcResponse<any>).state.headers.get('etag'), 'abc')
  })

  test('json() buffers the body for the executor and flips bodySet', ({ assert }) => {
    const ctx = makeContext()
    ;(ctx.response as XrpcResponse<any>).json({ id: 'x' })
    const state = (ctx.response as XrpcResponse<any>).state
    assert.deepEqual(state.body, { id: 'x' })
    assert.isTrue(state.bodySet)
  })

  test('bodySet defaults to false when json() is never called', ({ assert }) => {
    const ctx = makeContext()
    ;(ctx.response as XrpcResponse<any>).status(204)
    const state = (ctx.response as XrpcResponse<any>).state
    assert.isFalse(state.bodySet)
    assert.isUndefined(state.body)
  })

  test('initial state has empty Headers and undefined status / body / redirect', ({ assert }) => {
    const ctx = makeContext()
    const state = (ctx.response as XrpcResponse<any>).state
    assert.isUndefined(state.status)
    assert.isUndefined(state.body)
    assert.isUndefined(state.redirect)
    assert.isFalse(state.bodySet)
    assert.instanceOf(state.headers, Headers)
    assert.equal([...state.headers].length, 0)
  })

  test('redirect() records url + status on state', ({ assert }) => {
    const ctx = makeContext()
    ;(ctx.response as XrpcResponse<any>).redirect('https://cdn.example/blob.bin', 302)
    const state = (ctx.response as XrpcResponse<any>).state
    assert.deepEqual(state.redirect, { url: 'https://cdn.example/blob.bin', status: 302 })
  })
})

test.group('XrpcStream — subscription helpers', () => {
  test('signal / aborted mirror the AbortController', ({ assert }) => {
    const ac = new AbortController()
    const ctx = makeContext({ lexicon: subscriptionLex, signal: ac.signal })
    const stream = ctx.response as XrpcStream<any>
    assert.instanceOf(stream, XrpcStream)
    assert.equal(stream.signal, ac.signal)
    assert.isFalse(stream.aborted)
    ac.abort()
    assert.isTrue(stream.aborted)
  })

  test('message() returns a payload with the $type discriminator derived from NSID + ref', ({
    assert,
  }) => {
    const ctx = makeContext({ lexicon: subscriptionLex })
    const stream = ctx.response as XrpcStream<any>
    assert.instanceOf(stream, XrpcStream)
    const msg = (stream as any).message('#labels', { seq: 1 })
    assert.deepEqual(msg, { $type: 'com.example.test.sub#labels', seq: 1 })
  })
})

test.group('Macroable extension points', () => {
  test('XrpcContext / XrpcResponse / XrpcStream expose static .macro', ({ assert }) => {
    assert.isFunction((XrpcContext as any).macro)
    assert.isFunction((XrpcResponse as any).macro)
    assert.isFunction((XrpcStream as any).macro)
  })
})
