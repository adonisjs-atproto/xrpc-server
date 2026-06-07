import { test } from '@japa/runner'
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import { XrpcHttpContext } from '../../src/context/http.ts'
import { XrpcSubscriptionContext } from '../../src/context/subscription.ts'
import { isHttpContext, isSubscriptionContext } from '../../src/context/helpers.ts'

const procedureLex = { nsid: 'com.example.test.proc', type: 'xrpc_procedure' } as any
const subscriptionLex = { nsid: 'com.example.test.sub', type: 'xrpc_subscription' } as any

function baseParams() {
  const httpCtx = new HttpContextFactory().create()
  return {
    request: httpCtx.request,
    signal: new AbortController().signal,
    logger: httpCtx.logger,
    containerResolver: httpCtx.containerResolver,
    requestId: httpCtx.request.id() ?? 'test-req-id',
  }
}

test.group('isHttpContext', () => {
  test('returns true for XrpcHttpContext instances', ({ assert }) => {
    const ctx = new XrpcHttpContext({
      ...baseParams(),
      lexicon: procedureLex,
      params: {},
      input: undefined,
    })
    assert.isTrue(isHttpContext(ctx))
  })

  test('returns false for XrpcSubscriptionContext instances', ({ assert }) => {
    const ctx = new XrpcSubscriptionContext({
      ...baseParams(),
      lexicon: subscriptionLex,
      params: {},
    })
    assert.isFalse(isHttpContext(ctx))
  })

  test('narrows for downstream type-aware reads', ({ assert }) => {
    const ctx = new XrpcHttpContext({
      ...baseParams(),
      lexicon: procedureLex,
      params: {},
      input: undefined,
    })
    if (isHttpContext(ctx)) {
      assert.exists(ctx.response)
    }
  })
})

test.group('isSubscriptionContext', () => {
  test('returns true for XrpcSubscriptionContext instances', ({ assert }) => {
    const ctx = new XrpcSubscriptionContext({
      ...baseParams(),
      lexicon: subscriptionLex,
      params: {},
    })
    assert.isTrue(isSubscriptionContext(ctx))
  })

  test('returns false for XrpcHttpContext instances', ({ assert }) => {
    const ctx = new XrpcHttpContext({
      ...baseParams(),
      lexicon: procedureLex,
      params: {},
      input: undefined,
    })
    assert.isFalse(isSubscriptionContext(ctx))
  })

  test('narrows for downstream type-aware reads', ({ assert }) => {
    const ctx = new XrpcSubscriptionContext({
      ...baseParams(),
      lexicon: subscriptionLex,
      params: {},
    })
    if (isSubscriptionContext(ctx)) {
      assert.exists(ctx.stream)
    }
  })
})
