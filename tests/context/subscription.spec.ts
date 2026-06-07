import { test } from '@japa/runner'
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import { XrpcOperationContext } from '../../src/context/operation.ts'
import { XrpcSubscriptionContext } from '../../src/context/subscription.ts'
import { XrpcStream } from '../../src/stream.ts'

const subscriptionLex = { nsid: 'com.example.test.sub', type: 'xrpc_subscription' } as any

function makeSubscriptionContext(
  overrides: { lexicon?: any; params?: any; signal?: AbortSignal } = {}
) {
  const httpCtx = new HttpContextFactory().create()
  const lexicon = overrides.lexicon ?? subscriptionLex
  return new XrpcSubscriptionContext({
    lexicon,
    request: httpCtx.request,
    params: overrides.params ?? {},
    signal: overrides.signal ?? new AbortController().signal,
    logger: httpCtx.logger,
    containerResolver: httpCtx.containerResolver,
    requestId: httpCtx.request.id() ?? 'test-req-id',
  })
}

test.group('XrpcSubscriptionContext — construction', () => {
  test('exposes the materialized base primitives directly', ({ assert }) => {
    const ctx = makeSubscriptionContext()
    assert.isObject(ctx.logger)
    assert.isObject(ctx.containerResolver)
    assert.isString(ctx.requestId)
    assert.isObject(ctx.request)
  })

  test('type is the literal "subscription"', ({ assert }) => {
    const ctx = makeSubscriptionContext()
    assert.equal(ctx.type, 'subscription')
  })

  test('exposes stream as XrpcStream instance', ({ assert }) => {
    const ctx = makeSubscriptionContext()
    assert.instanceOf(ctx.stream, XrpcStream)
  })

  test('is an instance of XrpcOperationContext (inheritance)', ({ assert }) => {
    const ctx = makeSubscriptionContext()
    assert.instanceOf(ctx, XrpcOperationContext as any)
  })
})

test.group('XrpcSubscriptionContext.get / .getOrFail — ALS', () => {
  test('get() returns undefined outside any als.run scope', ({ assert }) => {
    assert.isUndefined(XrpcSubscriptionContext.get())
  })

  test('getOrFail() throws outside any als.run scope', ({ assert }) => {
    assert.throws(
      () => XrpcSubscriptionContext.getOrFail(),
      /XrpcSubscriptionContext is not available/
    )
  })

  test('both return the active subscription context inside an als.run scope', async ({
    assert,
  }) => {
    const ctx = makeSubscriptionContext()
    await XrpcOperationContext.als.run(ctx, async () => {
      assert.equal(XrpcSubscriptionContext.get(), ctx)
      assert.equal(XrpcSubscriptionContext.getOrFail(), ctx)
      await new Promise((r) => setImmediate(r))
      assert.equal(XrpcSubscriptionContext.get(), ctx)
      assert.equal(XrpcSubscriptionContext.getOrFail(), ctx)
    })
  })
})

test.group('XrpcSubscriptionContext — stream helpers', () => {
  test('stream.signal / aborted mirror the AbortController', ({ assert }) => {
    const ac = new AbortController()
    const ctx = makeSubscriptionContext({ signal: ac.signal })
    assert.equal(ctx.stream.signal, ac.signal)
    assert.isFalse(ctx.stream.aborted)
    ac.abort()
    assert.isTrue(ctx.stream.aborted)
  })

  test('stream.message() returns a payload with $type derived from NSID + ref', ({
    assert,
  }) => {
    const ctx = makeSubscriptionContext()
    const msg = (ctx.stream as any).message('#labels', { seq: 1 })
    assert.deepEqual(msg, { $type: 'com.example.test.sub#labels', seq: 1 })
  })
})

test.group('XrpcSubscriptionContext — Macroable', () => {
  test('exposes static .macro inherited from Macroable', ({ assert }) => {
    assert.isFunction((XrpcSubscriptionContext as any).macro)
  })
})
