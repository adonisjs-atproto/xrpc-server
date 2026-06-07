import { test } from '@japa/runner'
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import { XrpcOperationContext } from '../../src/context/operation.ts'
import { XrpcHttpContext } from '../../src/context/http.ts'
import { XrpcResponse } from '../../src/response.ts'

const queryLex = { nsid: 'com.example.test.query', type: 'xrpc_query' } as any
const procedureLex = { nsid: 'com.example.test.proc', type: 'xrpc_procedure' } as any

function makeHttpContext(overrides: { lexicon?: any; input?: any; params?: any } = {}) {
  const httpCtx = new HttpContextFactory().create()
  const lexicon = overrides.lexicon ?? procedureLex
  return new XrpcHttpContext({
    lexicon,
    request: httpCtx.request,
    input: overrides.input,
    params: overrides.params ?? {},
    signal: new AbortController().signal,
    logger: httpCtx.logger,
    containerResolver: httpCtx.containerResolver,
    requestId: httpCtx.request.id() ?? 'test-req-id',
  })
}

test.group('XrpcHttpContext — construction', () => {
  test('exposes the materialized base primitives directly', ({ assert }) => {
    const ctx = makeHttpContext()
    assert.isObject(ctx.logger)
    assert.isObject(ctx.containerResolver)
    assert.isString(ctx.requestId)
    assert.isObject(ctx.request)
  })

  test('procedure-kind lexicon sets type to "procedure"', ({ assert }) => {
    const ctx = makeHttpContext({ lexicon: procedureLex })
    assert.equal(ctx.type, 'procedure')
  })

  test('query-kind lexicon sets type to "query"', ({ assert }) => {
    const ctx = makeHttpContext({ lexicon: queryLex })
    assert.equal(ctx.type, 'query')
  })

  test('exposes response as XrpcResponse instance', ({ assert }) => {
    const ctx = makeHttpContext()
    assert.instanceOf(ctx.response, XrpcResponse)
  })

  test('is an instance of XrpcOperationContext (inheritance)', ({ assert }) => {
    const ctx = makeHttpContext()
    assert.instanceOf(ctx, XrpcOperationContext as any)
  })
})

test.group('XrpcHttpContext.get / .getOrFail — ALS', () => {
  test('get() returns undefined outside any als.run scope', ({ assert }) => {
    assert.isUndefined(XrpcHttpContext.get())
  })

  test('getOrFail() throws outside any als.run scope', ({ assert }) => {
    assert.throws(() => XrpcHttpContext.getOrFail(), /XrpcHttpContext is not available/)
  })

  test('both return the active HTTP context inside an als.run scope', async ({ assert }) => {
    const ctx = makeHttpContext()
    await XrpcOperationContext.als.run(ctx, async () => {
      assert.equal(XrpcHttpContext.get(), ctx)
      assert.equal(XrpcHttpContext.getOrFail(), ctx)
      await new Promise((r) => setImmediate(r))
      assert.equal(XrpcHttpContext.get(), ctx)
      assert.equal(XrpcHttpContext.getOrFail(), ctx)
    })
  })

  test('nested scopes shadow the outer context', async ({ assert }) => {
    const outer = makeHttpContext()
    const inner = makeHttpContext()
    await XrpcOperationContext.als.run(outer, async () => {
      assert.equal(XrpcHttpContext.getOrFail(), outer)
      await XrpcOperationContext.als.run(inner, async () => {
        assert.equal(XrpcHttpContext.getOrFail(), inner)
      })
      assert.equal(XrpcHttpContext.getOrFail(), outer)
    })
  })

  test('XrpcOperationContext.als also returns the HTTP context (shared storage)', async ({
    assert,
  }) => {
    const ctx = makeHttpContext()
    await XrpcOperationContext.als.run(ctx, async () => {
      assert.equal(XrpcOperationContext.getOrFail(), ctx)
    })
  })
})

test.group('XrpcHttpContext — response state', () => {
  test('status / header mutate internal state and return this', ({ assert }) => {
    const ctx = makeHttpContext()
    const ret = ctx.response.status(201).header('etag', 'abc')
    assert.equal(ret, ctx.response, 'chain returns itself')
    assert.equal(ctx.response.state.status, 201)
    assert.equal(ctx.response.state.headers.get('etag'), 'abc')
  })

  test('json() buffers the body and flips bodySet', ({ assert }) => {
    const ctx = makeHttpContext()
    ctx.response.json({ id: 'x' } as any)
    assert.deepEqual(ctx.response.state.body, { id: 'x' })
    assert.isTrue(ctx.response.state.bodySet)
  })

  test('bodySet defaults to false when json() is never called', ({ assert }) => {
    const ctx = makeHttpContext()
    ctx.response.status(204)
    assert.isFalse(ctx.response.state.bodySet)
    assert.isUndefined(ctx.response.state.body)
  })

  test('initial state has empty Headers and undefined status / body / redirect', ({ assert }) => {
    const ctx = makeHttpContext()
    const state = ctx.response.state
    assert.isUndefined(state.status)
    assert.isUndefined(state.body)
    assert.isUndefined(state.redirect)
    assert.isFalse(state.bodySet)
    assert.instanceOf(state.headers, Headers)
    assert.equal([...state.headers].length, 0)
  })

  test('redirect() records url + status on state', ({ assert }) => {
    const ctx = makeHttpContext()
    ctx.response.redirect('https://cdn.example/blob.bin', 302)
    assert.deepEqual(ctx.response.state.redirect, {
      url: 'https://cdn.example/blob.bin',
      status: 302,
    })
  })
})

test.group('XrpcHttpContext — Macroable', () => {
  test('exposes static .macro inherited from Macroable', ({ assert }) => {
    assert.isFunction((XrpcHttpContext as any).macro)
  })
})
