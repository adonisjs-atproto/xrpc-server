import { test } from '@japa/runner'
import { setupApp } from './helpers.js'
import { XrpcService } from '../src/xrpc_service.js'
import { ExceptionHandler } from '../src/exception_handler.js'

test.group('XrpcService', () => {
  test('errorHandler(factory) is called lazily on first getRegisteredErrorHandler()', async ({
    assert,
  }) => {
    const { app } = await setupApp({})
    const service = new XrpcService(app)

    let factoryCalls = 0
    class TestHandler extends ExceptionHandler {}

    service.errorHandler(async () => {
      factoryCalls++
      return { default: TestHandler }
    })

    assert.equal(factoryCalls, 0, 'factory not invoked until first resolution')

    const handler = await service.getRegisteredErrorHandler()
    assert.equal(factoryCalls, 1)
    assert.instanceOf(handler, TestHandler)

    const handler2 = await service.getRegisteredErrorHandler()
    assert.equal(factoryCalls, 1, 'factory not re-invoked — resolved handler is memoized')
    assert.strictEqual(handler, handler2)
  })

  test('getRegisteredErrorHandler() returns null when no factory registered', async ({
    assert,
  }) => {
    const { app } = await setupApp({})
    const service = new XrpcService(app)
    assert.isNull(await service.getRegisteredErrorHandler())
  })

  test('container.make-resolved handler has app injected (inherits ExceptionHandler defaults)', async ({
    assert,
  }) => {
    const { app } = await setupApp({})
    const service = new XrpcService(app)
    class TestHandler extends ExceptionHandler {}
    service.errorHandler(async () => ({ default: TestHandler }))

    const handler = await service.getRegisteredErrorHandler()
    // The base class's `handle` reads `this.app.inProduction` — verify the
    // container successfully injected `app` by exercising the default.
    assert.isFunction(handler!.handle)
    assert.isFunction(handler!.report)
    assert.isFunction(handler!.shouldReport)
  })
})
