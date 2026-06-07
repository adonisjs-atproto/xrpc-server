/**
 * End-to-end error-reporting tests. Exercise the full path:
 * real HTTP request → dispatch middleware → atcute XRPCRouter →
 * executor try/catch → runConsumerHandler (report + handle) → wire response.
 *
 * For subscription paths, drive the WS side via `injectXrpcSubscription`.
 */

import { test } from '@japa/runner'
import inject from 'light-my-request'
import { procedure, subscription, object } from '@atcute/lexicons/validations'

import { setupApp } from './helpers.js'
import { ExceptionHandler } from '../src/exception_handler.js'
import { NotFoundError } from '../src/errors.js'
import type { XrpcError } from '../src/errors.js'
import type { XrpcOperationContext } from '../src/context/main.js'
import { injectXrpcSubscription } from '../src/test_utils.js'

const FAIL_PROC = procedure('com.example.fail', {
  params: null,
  input: { type: 'lex', schema: object({}) },
  output: null,
})

const FAIL_SUB = subscription('com.example.failsub', {
  params: object({}),
  message: null,
})

test.group('end-to-end error reporting', () => {
  test('procedure handler throw: report() fires once + handle()-returned XrpcError encoded', async ({
    assert,
  }) => {
    const reportCalls: Array<{ err: unknown; ctx: XrpcOperationContext | null }> = []
    const handleReturn = new NotFoundError('sanitized in handle()')

    class SpyHandler extends ExceptionHandler {
      override async report(err: unknown, ctx: XrpcOperationContext | null) {
        reportCalls.push({ err, ctx })
      }
      override async handle(_err: unknown) {
        return handleReturn
      }
    }

    const { app } = await setupApp(
      {
        rcFileContents: { providers: [() => import('../providers/provider.js')] },
      },
      {
        beforeReady: async (testApp) => {
          const router = await testApp.container.make('router')
          router.xrpc.procedure(FAIL_PROC as any, () => {
            throw new Error('internal boom')
          })
          // Register the spy handler before ready() so it's in place when the
          // executor first runs. container.make(SpyHandler) constructs it with
          // `app` injected — closure captures `reportCalls` + `handleReturn`.
          const xrpc = await testApp.container.make('xrpc')
          xrpc.errorHandler(async () => ({ default: SpyHandler }))
        },
      }
    )

    const server = await app.container.make('server')
    await server.boot()
    const response = await inject(server.handle.bind(server))
      .post('/xrpc/com.example.fail')
      .headers({ 'content-type': 'application/json' })
      .payload('{}')

    // Dedup: executor catch stamps REPORTED; atcute's handleException hook
    // short-circuits on the symbol. So report() fires exactly once.
    assert.lengthOf(reportCalls, 1, 'reporter fired exactly once (REPORTED-symbol dedup)')
    assert.instanceOf(reportCalls[0].err, Error)
    assert.match((reportCalls[0].err as Error).message, /internal boom/)
    // ctx carries the XrpcContext from the executor ALS scope.
    assert.isNotNull(reportCalls[0].ctx)
    assert.property(reportCalls[0].ctx, 'lexicon')

    // Wire response carries the SANITIZED error (NotFoundError), not the
    // raw "internal boom" message.
    assert.equal(response.statusCode, 404, response.payload)
    const body = JSON.parse(response.payload)
    assert.equal(body.error, 'NotFound')
    assert.equal(body.message, 'sanitized in handle()')
  })

  test('subscription handler throw: report() fires + handle()-returned error wraps to XRPCSubscriptionError frame', async ({
    assert,
  }) => {
    const reportCalls: unknown[] = []
    const handleReturn = new NotFoundError('sanitized subscription error')

    class SubSpyHandler extends ExceptionHandler {
      override async report(err: unknown) {
        reportCalls.push(err)
      }
      override async handle(_err: unknown) {
        return handleReturn
      }
    }

    const { app } = await setupApp(
      {
        rcFileContents: { providers: [() => import('../providers/provider.js')] },
      },
      {
        beforeReady: async (testApp) => {
          const router = await testApp.container.make('router')
          router.xrpc.subscription(FAIL_SUB as any, async function* () {
            yield { $type: 'com.example.failsub#tick', n: 1 }
            throw new Error('subscription exploded')
          })
          const xrpc = await testApp.container.make('xrpc')
          xrpc.errorHandler(async () => ({ default: SubSpyHandler }))
        },
      }
    )

    const adonisServer = await app.container.make('server')
    const nodeServer = adonisServer.getNodeServer()!

    const stream = await injectXrpcSubscription(nodeServer, FAIL_SUB as any)

    // Drain the stream — first message succeeds, then the generator throws.
    const collected: any[] = []
    let errorFrame: any = null
    for await (const frame of stream.messages()) {
      if (frame.type === 'message') {
        collected.push(frame)
      } else if (frame.type === 'error') {
        errorFrame = frame
        break
      }
    }
    await stream.close().catch(() => {})

    assert.lengthOf(collected, 1, 'first tick should arrive before the throw')
    assert.isNotNull(errorFrame, 'an error frame should have been emitted')

    // The error frame carries the sanitized error from handle().
    // DecodedFrame for errors: { type: 'error'; error: string; message?: string }
    assert.equal(errorFrame.error, handleReturn.errorName)
    assert.match(errorFrame.message, /sanitized subscription error/)

    // report() fired once with the original error.
    assert.lengthOf(reportCalls, 1)
    assert.instanceOf(reportCalls[0], Error)
    assert.match((reportCalls[0] as Error).message, /subscription exploded/)
  })

  test('no handler registered: wire response is still well-formed InternalServerError (Plan 03 fallback)', async ({
    assert,
  }) => {
    // No xrpc.errorHandler() registration — getRegisteredErrorHandler() returns
    // null. Executor falls back to the Plan 03 inline InternalServerError wrap.
    const { app } = await setupApp(
      {
        rcFileContents: { providers: [() => import('../providers/provider.js')] },
      },
      {
        beforeReady: async (testApp) => {
          const router = await testApp.container.make('router')
          router.xrpc.procedure(FAIL_PROC as any, () => {
            throw new Error('raw error, no handler registered')
          })
        },
      }
    )

    const server = await app.container.make('server')
    await server.boot()
    const response = await inject(server.handle.bind(server))
      .post('/xrpc/com.example.fail')
      .headers({ 'content-type': 'application/json' })
      .payload('{}')

    assert.equal(response.statusCode, 500, response.payload)
    const body = JSON.parse(response.payload)
    assert.equal(body.error, 'InternalServerError')
    assert.match(body.message, /raw error, no handler registered/)
  })

  test('XrpcError pass-through: XrpcError thrown by handler is not double-wrapped', async ({
    assert,
  }) => {
    // Handler throws an XrpcError (InvalidRequest). Fallback path passes it
    // through unchanged (not double-wrapped in InternalServerError).
    const { app } = await setupApp(
      {
        rcFileContents: { providers: [() => import('../providers/provider.js')] },
      },
      {
        beforeReady: async (testApp) => {
          const router = await testApp.container.make('router')
          router.xrpc.procedure(FAIL_PROC as any, () => {
            throw new NotFoundError('resource does not exist')
          })
        },
      }
    )

    const server = await app.container.make('server')
    await server.boot()
    const response = await inject(server.handle.bind(server))
      .post('/xrpc/com.example.fail')
      .headers({ 'content-type': 'application/json' })
      .payload('{}')

    assert.equal(response.statusCode, 404, response.payload)
    const body = JSON.parse(response.payload)
    assert.equal(body.error, 'NotFound')
    assert.equal(body.message, 'resource does not exist')
  })

  test('reporter throw does not mask handle()-returned error on the wire', async ({ assert }) => {
    const handleReturn = new NotFoundError('handle()-returned despite reporter crash')

    class ThrowingReporter extends ExceptionHandler {
      override async report() {
        throw new Error('Sentry / logger network failure')
      }
      override async handle(_err: unknown): Promise<XrpcError> {
        return handleReturn
      }
    }

    const { app } = await setupApp(
      {
        rcFileContents: { providers: [() => import('../providers/provider.js')] },
      },
      {
        beforeReady: async (testApp) => {
          const router = await testApp.container.make('router')
          router.xrpc.procedure(FAIL_PROC as any, () => {
            throw new Error('original error')
          })
          const xrpc = await testApp.container.make('xrpc')
          xrpc.errorHandler(async () => ({ default: ThrowingReporter }))
        },
      }
    )

    const server = await app.container.make('server')
    await server.boot()
    const response = await inject(server.handle.bind(server))
      .post('/xrpc/com.example.fail')
      .headers({ 'content-type': 'application/json' })
      .payload('{}')

    // Reporter crashing must NOT affect the wire response — handle() still ran
    // and its return value was encoded.
    assert.equal(response.statusCode, 404, response.payload)
    const body = JSON.parse(response.payload)
    assert.equal(body.error, 'NotFound')
    assert.match(body.message, /handle\(\)-returned despite reporter crash/)
  })
})
