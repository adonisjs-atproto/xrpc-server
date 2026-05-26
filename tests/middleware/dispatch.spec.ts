import { test } from '@japa/runner'
import { setupApp } from '../helpers.js'
import XrpcDispatchMiddleware from '../../src/middleware/dispatch.js'

test.group('XrpcDispatchMiddleware', (group) => {
  let app: any
  group.each.setup(async () => {
    const ctx = await setupApp()
    app = ctx.app
  })

  test('passes through non-/xrpc/* requests untouched', async ({ assert }) => {
    const middleware = new XrpcDispatchMiddleware()
    let nextCalled = false
    const ctx = {
      request: { url: () => '/some/other/path' },
      response: {},
      containerResolver: app.container.createResolver(),
    } as any

    await middleware.handle(ctx, async () => {
      nextCalled = true
    })

    assert.isTrue(nextCalled, 'next() should have been called for non-xrpc paths')
  })

  test('throws RuntimeException if no XrpcServer is bound on /xrpc/* paths', async ({
    assert,
  }) => {
    const middleware = new XrpcDispatchMiddleware()
    const ctx = {
      request: { url: () => '/xrpc/com.example.ping' },
      response: {},
      containerResolver: app.container.createResolver(),
    } as any

    await assert.rejects(
      async () => middleware.handle(ctx, async () => {}),
      /XrpcServer.+not bound|cannot resolve/i
    )
  })
})
