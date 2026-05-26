import { test } from '@japa/runner'
import { setupApp } from './helpers.js'
import { ExceptionHandler } from '../src/exception_handler.js'
import { InternalServerError, NotFoundError } from '../src/errors.js'

test.group('ExceptionHandler — defaults', () => {
  test('shouldReport returns true by default', async ({ assert }) => {
    const { app } = await setupApp({})
    const handler = new ExceptionHandler(app)
    assert.isTrue(handler.shouldReport(new Error('whatever')))
  })

  test('report is a no-op by default', async ({ assert }) => {
    const { app } = await setupApp({})
    const handler = new ExceptionHandler(app)
    const result = await handler.report(new Error('whatever'), null)
    assert.isUndefined(result)
  })

  test('handle passes through XrpcError instances unchanged', async ({ assert }) => {
    const { app } = await setupApp({})
    const handler = new ExceptionHandler(app)
    const original = new NotFoundError('missing thing')
    const result = await handler.handle(original, null)
    assert.strictEqual(result, original)
  })

  test('handle wraps unexpected errors with InternalServerError and preserves cause in development', async ({
    assert,
  }) => {
    const { app } = await setupApp({})
    const handler = new ExceptionHandler(app)
    const original = new Error('something broke internally')
    const result = await handler.handle(original, null)
    assert.instanceOf(result, InternalServerError)
    assert.equal(result.message, 'something broke internally')
    assert.strictEqual((result as any).cause, original)
  })

  test('handle replaces unexpected errors with a generic InternalServerError in production', async ({
    assert,
  }) => {
    // Bypass setupApp for this one — we just need an app shape with
    // inProduction:true to drive the env branch. The handler doesn't
    // touch any other app surface in its default handle() implementation.
    const fakeProdApp = { inProduction: true } as any
    const handler = new ExceptionHandler(fakeProdApp)
    const result = await handler.handle(new Error('internal detail'), null)
    assert.instanceOf(result, InternalServerError)
    assert.equal(result.message, 'Internal Server Error')
    assert.isUndefined((result as any).cause, 'cause must not leak in production')
  })

  test('handle wraps non-Error throwables (strings, plain objects) safely', async ({ assert }) => {
    const { app } = await setupApp({})
    const handler = new ExceptionHandler(app)

    const fromString = await handler.handle('a bare string was thrown', null)
    assert.instanceOf(fromString, InternalServerError)
    assert.equal(fromString.message, 'a bare string was thrown')

    const fromObject = await handler.handle({ weird: 'object' }, null)
    assert.instanceOf(fromObject, InternalServerError)
    assert.equal(fromObject.message, '[object Object]')
  })
})

test.group('ExceptionHandler — consumer subclass shape', () => {
  test('subclass can override report to capture errors', async ({ assert }) => {
    const captured: Array<{ error: unknown; nsid: string | undefined }> = []
    class TestHandler extends ExceptionHandler {
      async report(error: unknown, ctx: any) {
        captured.push({ error, nsid: ctx?.lexicon?.nsid })
      }
    }

    const { app } = await setupApp({})
    const handler = new TestHandler(app)
    await handler.report(new Error('boom'), null)
    assert.lengthOf(captured, 1)
    assert.equal((captured[0].error as Error).message, 'boom')
    assert.isUndefined(captured[0].nsid)
  })

  test('subclass calling super.handle keeps the sanitization default', async ({ assert }) => {
    let reportFired = 0
    class TestHandler extends ExceptionHandler {
      async report(_error: unknown, _ctx: any) {
        reportFired++
      }
      async handle(error: unknown, ctx: any) {
        if (this.shouldReport(error)) {
          await this.report(error, ctx)
        }
        return super.handle(error, ctx)
      }
    }

    const { app } = await setupApp({})
    const handler = new TestHandler(app)
    const result = await handler.handle(new Error('boom'), null)
    assert.equal(reportFired, 1)
    assert.instanceOf(result, InternalServerError)
    assert.equal(result.message, 'boom')
  })
})
