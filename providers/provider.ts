import { Router } from '@adonisjs/core/http'
import { XRPCRouter } from '@atcute/xrpc-server'
import { createNodeWebSocket } from '@atcute/xrpc-server-node'
import type { ApplicationService } from '@adonisjs/core/types'
import type { ContainerProviderContract } from '@adonisjs/application/types'

import { XrpcRouter } from '../src/router/index.js'
import { XrpcServer, createXrpcExecutor } from '../src/xrpc_server.js'
import { XrpcSerializer } from '../src/serializer.js'
import { XrpcService, REPORTED } from '../src/xrpc_service.js'
import { XrpcContext } from '../src/context.js'
import { XrpcError, InternalServerError } from '../src/errors.js'

declare module '@adonisjs/core/types' {
  export interface ContainerBindings {
    xrpcRouter: XrpcRouter
    xrpc: XrpcService
  }
}

/**
 * Minimal XRPC provider — Plan 03 scope.
 *
 * register(): binds the XrpcRouter as a container singleton. Runs before
 * any other provider's boot(), so the binding is available by the time
 * boot() resolves it.
 *
 * boot(): resolves the XrpcRouter singleton eagerly and installs a
 * `router.xrpc` getter on `Router.prototype` via `Object.defineProperty`.
 * (The main `Router` class isn't `Macroable` in `@adonisjs/http-server@8.x`
 * — only the route sub-classes are — so `Router.macro(...)` /
 * `Router.getter(...)` aren't available; the prototype-property primitive
 * is what `Macroable.getter` wraps internally anyway.) Middleware
 * mounting is the consumer's responsibility (start/kernel.ts) or
 * setupApp's (tests) — not the provider's.
 *
 * start() (all environments): commits the XrpcRouter so further
 * `router.xrpc.*()` registrations throw. Not gated on env because Plan 06's
 * `list:xrpc:routes` ace command (and any other future console-env
 * tooling) needs to read the committed registry too.
 *
 * ready() (skips in `console` env only): constructs the atcute XRPCRouter
 * + executor + XrpcServer, container-binds, then calls `XrpcServer.start()`
 * to install routes onto atcute and wire the WS upgrade handler. Plan 04
 * expands this with `XrpcService` facade, error-reporter registration,
 * and atcute's handleException / handleSubscriptionException wiring.
 */
export default class XrpcProvider implements ContainerProviderContract {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton(XrpcRouter, () => new XrpcRouter(this.app))
    this.app.container.alias('xrpcRouter', XrpcRouter)

    // Bound here so `services/xrpc.ts`'s `app.booted(...)` hook can resolve
    // it. The 'xrpc' alias is what `services/xrpc.ts` resolves against —
    // keep it stable.
    this.app.container.singleton(XrpcService, () => new XrpcService(this.app))
    this.app.container.alias('xrpc', XrpcService)
  }

  async boot() {
    // Resolve eagerly so the getter body can return synchronously —
    // `router.xrpc.procedure(...)` is called synchronously at consumer
    // route-definition time, so the getter can't hand back a Promise.
    // Router instances don't expose `app`/container themselves (their
    // `#app` field is private), so closure capture from boot() is the
    // only way to thread the resolved XrpcRouter into the getter body.
    const xrpcRouter = await this.app.container.make(XrpcRouter)

    // `configurable: true` so that re-running `boot()` across multiple
    // `setupApp()` calls in the test suite redefines the getter cleanly
    // rather than throwing `TypeError: Cannot redefine property`.
    Object.defineProperty(Router.prototype, 'xrpc', {
      get() {
        return xrpcRouter
      },
      configurable: true,
      enumerable: false,
    })
  }

  /**
   * `start()` runs between `boot()` and `ready()` in the AdonisJS provider
   * lifecycle — after all preloads have loaded (so consumer
   * `start/routes.ts` has had a chance to register XRPC routes) and before
   * the app is considered ready. This is the right semantic moment to
   * commit/seal the XrpcRouter: any further `router.xrpc.procedure(...)`
   * calls after commit() throw, which is what we want once the app is
   * about to serve traffic.
   *
   * NOT gated on env — ace commands (Plan 06's `list:xrpc:routes`, etc.)
   * run in the `console` env and need to read the canonical committed
   * registry. Preloads run in all environments by default, so the
   * XrpcRouter is fully populated by the time start() fires regardless
   * of env.
   */
  async start() {
    const xrpcRouter = await this.app.container.make('xrpcRouter')
    xrpcRouter.commit()
  }

  async ready() {
    // Skip only in `console` env. The test env still needs the XrpcServer
    // wired so functional tests can exercise the dispatch pipeline.
    if (this.app.getEnvironment() === 'console') return

    // By this point provider `start()` has already committed the XrpcRouter
    // — the executor sees the final operations map. We pass the live Map
    // reference (the executor reads from it at dispatch time); commit just
    // sealed further registration.
    const xrpcRouter = await this.app.container.make('xrpcRouter')
    const xrpc = await this.app.container.make('xrpc')

    const ws = createNodeWebSocket()

    // Asymmetric hook wiring — see the Amendments section in Plan 04:
    // - handleException: fires for atcute-internal HTTP errors (parse
    //   failures, lexicon assertion, route mismatch) that never reach our
    //   executor's try/catch. Dedup via REPORTED symbol for handler-side
    //   errors that already went through runConsumerHandler.
    // - onSocketError: subscription telemetry only — atcute has already
    //   closed the socket with 1011 before this fires. No return path; no
    //   handle() call. Subscription-path handler errors are covered by
    //   wrapSubscriptionIterator's catch block (Task 3).
    const atcuteRouter = new XRPCRouter({
      websocket: ws.adapter,
      handleException: makeAtcuteHttpHook(xrpc),
      onSocketError: makeSocketErrorObserver(xrpc),
    })
    const executor = createXrpcExecutor({
      operations: xrpcRouter.operations,
      serializer: new XrpcSerializer(),
      xrpc,
    })
    const xrpcServer = new XrpcServer({
      app: this.app,
      router: atcuteRouter,
      ws,
      executor,
    })
    this.app.container.bindValue(XrpcServer, xrpcServer)

    await xrpcServer.start()

    // Register AFTER `HttpServerProcess.#monitorAppAndServer` has registered
    // its own `terminating` hook (which calls `nodeHttpServer.close()`).
    // `app.terminate()` runs terminating hooks via `runReverse` (LIFO), so
    // last-registered runs first — we send 1001 frames and drain WS clients
    // BEFORE the HTTP server tries to close. Without this ordering, the HTTP
    // server's `.close()` blocks waiting for the WS connections to drain,
    // and our shutdown() never gets called. See Plan 04 amendments block.
    this.app.terminating(async () => {
      await xrpcServer.shutdown()
    })
  }
}

/**
 * Build the atcute `handleException` hook (HTTP path). Runs the consumer's
 * registered ExceptionHandler against the error and throws the sanitized
 * XrpcError for atcute's wire encoder to produce the response body.
 *
 * **Dedup** (REPORTED symbol): handler-side errors enter the executor's
 * catch FIRST (Task 3's `runConsumerHandler`). The executor calls
 * `handler.report` + `handler.handle`, stamps the returned XrpcError with
 * `REPORTED`, and throws — atcute then sees the (already-sanitized)
 * XrpcError and calls THIS hook. We check the symbol and short-circuit so
 * reporting/handling isn't duplicated. Errors raised inside atcute before
 * reaching our executor (request parsing, lexicon assertion, route
 * matching) have no `REPORTED` stamp and get the full handler invocation.
 *
 * **XrpcContext.get()** returns the active context if the executor had
 * entered the ALS before throwing (HTTP handler-side errors). Atcute-
 * internal errors raised before the executor runs have no XrpcContext —
 * `get()` returns undefined and we pass null to the consumer's handler.
 */
function makeAtcuteHttpHook(xrpc: XrpcService) {
  return async (err: unknown): Promise<never> => {
    if ((err as any)?.[REPORTED]) {
      throw err
    }

    const handler = await xrpc.getRegisteredErrorHandler()
    if (!handler) {
      // No handler registered (tests, consumers who haven't wired
      // start/kernel.ts yet). Mirror runConsumerHandler's fallback so
      // atcute still gets a well-formed XrpcError.
      const fallback =
        err instanceof XrpcError
          ? err
          : new InternalServerError(err instanceof Error ? err.message : String(err), {
              cause: err,
            })
      ;(fallback as any)[REPORTED] = true
      throw fallback
    }

    const xrpcCtx = XrpcContext.get() ?? null

    if (handler.shouldReport(err)) {
      try {
        await handler.report(err, xrpcCtx)
      } catch {
        // Swallow reporter failures so the original error still gets
        // sanitized and re-thrown for atcute to encode.
      }
    }

    const sanitized = await handler.handle(err, xrpcCtx)
    ;(sanitized as any)[REPORTED] = true
    throw sanitized
  }
}

/**
 * Build the atcute `onSocketError` observer (subscription path). Atcute
 * invokes this AFTER it has closed the socket with 1011 for non-
 * `XRPCSubscriptionError` throws — telemetry-only, no return path.
 * Calls the consumer handler's `report` (when `shouldReport` is truthy)
 * so observability survives atcute-internal subscription failures.
 *
 * Does NOT call `handler.handle()` — the close frame has already gone,
 * there's nothing to sanitize for the wire. Does NOT throw — atcute's
 * cleanup path is finalized at this point.
 */
function makeSocketErrorObserver(xrpc: XrpcService) {
  return async ({ error, request }: { error: unknown; request: Request }): Promise<void> => {
    void request
    if ((error as any)?.[REPORTED]) {
      return
    }

    const handler = await xrpc.getRegisteredErrorHandler()
    if (!handler) return

    const xrpcCtx = XrpcContext.get() ?? null

    if (handler.shouldReport(error)) {
      try {
        await handler.report(error, xrpcCtx)
      } catch {
        // Telemetry hook is fire-and-forget; swallow reporter failures.
      }
    }
  }
}
