import { test } from '@japa/runner'
import { XrpcContextFactory } from '../factories/xrpc.js'
import { XrpcContext, XrpcResponse, XrpcStream } from '../src/context.js'

const procedureLex = { nsid: 'com.example.test.proc', type: 'xrpc_procedure' } as any
const subscriptionLex = { nsid: 'com.example.test.sub', type: 'xrpc_subscription' } as any

test.group('XrpcContextFactory', () => {
  test('throws if lexicon is not supplied', ({ assert }) => {
    assert.throws(() => new XrpcContextFactory().create(), /lexicon is required/)
  })

  test('creates an XrpcContext with defaults for procedure-kind lexicons', ({ assert }) => {
    const ctx = new XrpcContextFactory().merge({ lexicon: procedureLex }).create()
    assert.instanceOf(ctx, XrpcContext)
    assert.instanceOf(ctx.response, XrpcResponse)
    assert.deepEqual(ctx.params, {})
    assert.equal(ctx.input, undefined)
  })

  test('creates an XrpcContext with defaults for subscription-kind lexicons', ({ assert }) => {
    const ctx = new XrpcContextFactory().merge({ lexicon: subscriptionLex }).create()
    assert.instanceOf(ctx.response, XrpcStream)
  })

  test('forwards merged input / params overrides', ({ assert }) => {
    const ctx = new XrpcContextFactory()
      .merge({
        lexicon: procedureLex,
        input: { reasonType: 'spam' },
        params: { limit: 50 },
      })
      .create()
    assert.deepEqual(ctx.input, { reasonType: 'spam' })
    assert.deepEqual(ctx.params, { limit: 50 })
  })

  test('defaults logger / containerResolver / request from a fresh HttpContextFactory', ({
    assert,
  }) => {
    const ctx = new XrpcContextFactory().merge({ lexicon: procedureLex }).create()
    assert.isFunction(ctx.logger.info)
    assert.isObject(ctx.containerResolver)
    assert.isFunction((ctx.request as any).header)
  })
})
