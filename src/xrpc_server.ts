/*
|--------------------------------------------------------------------------
| XRPC dispatch layer
|--------------------------------------------------------------------------
|
| Two units live here:
|
| 1. `XrpcServer` — owns the atcute `XRPCRouter` + WebSocket adapter +
|    shared executor; exposes `start()` to wire the frozen `XrpcRouter`
|    builder's routes into atcute and install the upgrade handler. Called
|    from the provider's `ready()` phase (Plan 04).
|
| 2. `createXrpcExecutor` — builds the single shared executor function
|    that atcute invokes for every route. Closure captures the route
|    registry and the serializer; error reporting (Plan 04) splices in
|    at a clearly marked seam.
|
| RequestContext + requestContextStore + fromHttpContext live in
| `./request_context.js` — both XrpcServer and XrpcDispatchMiddleware
| import from there.
*/

import type http from 'node:http'
import { ServerResponse } from 'node:http'
import { RuntimeException } from '@adonisjs/core/exceptions'
import type { ApplicationService } from '@adonisjs/core/types'
import type { Server as AdonisServer } from '@adonisjs/core/http'

import type { XrpcRouter, RouteInfo } from './router/index.js'
import type { XrpcLexicon } from './types.js'
import type { XrpcSerializer } from './serializer.js'
import { XrpcContext } from './context.js'
import { XrpcError, InternalServerError, NotFoundError } from './errors.js'
import { type RequestContext, requestContextStore } from './request_context.js'

// Forward type-only references to atcute. Imports stay type-only so this
// module's *runtime* dependency surface is just the constructor names; the
// actual `XRPCRouter` / `createNodeWebSocket` instances are constructed by
// the provider (Plan 04) and passed into `XrpcServer`'s constructor.
import { XRPCSubscriptionError } from '@atcute/xrpc-server'
import type { XRPCRouter } from '@atcute/xrpc-server'
import type { createNodeWebSocket } from '@atcute/xrpc-server-node'

/**
 * The shared executor signature — one function per package instance,
 * registered with atcute for every route. The HTTP path returns a `Response`:
 * atcute's `XRPCRouter` checks `output instanceof Response` and silently
 * substitutes `new Response(null)` for non-Response returns, so the executor
 * MUST construct a Response itself — see Task 3's body for the conversion
 * from `xrpcCtx.response.state` + serialized body. The subscription path
 * returns an `AsyncIterable` of messages, which atcute iterates with
 * `for await` for frame encoding.
 */
export type SharedXrpcExecutor = (
  atcuteCtx: any,
  requestCtx?: RequestContext
) => Promise<Response> | AsyncIterable<unknown>

/**
 * Dispatch orchestrator. Owns the atcute `XRPCRouter` and the WebSocket
 * helper; exposes `start()` for the provider to invoke during `ready()`.
 */
export class XrpcServer {
  #app: ApplicationService
  #router: XRPCRouter
  #ws: ReturnType<typeof createNodeWebSocket>
  #executor: SharedXrpcExecutor

  constructor(deps: {
    app: ApplicationService
    router: XRPCRouter
    ws: ReturnType<typeof createNodeWebSocket>
    executor: SharedXrpcExecutor
  }) {
    this.#app = deps.app
    this.#router = deps.router
    this.#ws = deps.ws
    this.#executor = deps.executor
  }

  /**
   * Wire the frozen builder's routes into atcute's `XRPCRouter` and install
   * the WebSocket upgrade handler. Caller must have already called
   * `router.xrpc.commit()` (provider does this in `ready()` immediately
   * before invoking `start()`).
   */
  async start(): Promise<void> {
    // No `useAsyncLocalStorage: true` check — the package brings its own
    // `requestContextStore` ALS, entered by the HTTP dispatch middleware and the
    // WS upgrade listener at the dispatch boundary. We don't depend on
    // Adonis's HttpContext ALS for any read inside the executor.

    // Routes install unconditionally — registering routes on atcute's
    // XRPCRouter has no dependency on a Node HTTP server (the HTTP-side
    // dispatch flows through Adonis's middleware pipeline, which doesn't
    // care whether the server is bound to a port). Only the WebSocket
    // upgrade handler (Task 6) genuinely needs a node server.
    const router = await this.#app.container.make('router')
    this.#installRoutes(router.xrpc)

    // WebSocket upgrade handler only installs when a Node HTTP server is
    // attached. In tests that use `light-my-request` (no port binding) and
    // in `console` / `ace` environments, `getNodeServer()` returns
    // undefined — HTTP dispatch still works through Adonis's middleware,
    // and there's just nothing to upgrade.
    const appServer = await this.#app.container.make('server')
    const nodeServer = appServer.getNodeServer()
    if (!nodeServer) return
    this.#installWebSocketHandler(nodeServer, appServer)
  }

  /**
   * Install the Node server 'upgrade' listener for the XRPC subscription
   * dispatch path. Snips atcute's auto-registered listener and re-registers
   * a URL-filtering wrapper so non-XRPC upgrades (Vite HMR, app-defined WS
   * endpoints) pass through to other listeners untouched.
   *
   * TODO (upstream): file an issue against `mary-ext/atcute` adding an
   * optional `urlPredicate: (req: IncomingMessage) => boolean` to
   * `createNodeWebSocket`. With that, this method collapses to a single
   * `injectWebSocket` call + a `urlPredicate` argument.
   */
  #installWebSocketHandler(nodeServer: http.Server, appServer: AdonisServer): void {
    // Let atcute register its 'upgrade' listener, then capture it and
    // immediately remove it. We verify the listener-count delta is exactly 1
    // so we fail loudly if atcute's internals change (e.g. registers multiple
    // listeners or uses `prependListener`).
    const beforeCount = nodeServer.listenerCount('upgrade')
    this.#ws.injectWebSocket(nodeServer, this.#router)
    const upgradeListeners = nodeServer.listeners('upgrade')
    const addedCount = upgradeListeners.length - beforeCount
    const atcuteListener = upgradeListeners.at(-1) as any
    if (addedCount !== 1 || typeof atcuteListener !== 'function') {
      throw new RuntimeException(
        `@atcute/xrpc-server-node.injectWebSocket added ${addedCount} upgrade listeners (expected 1); the snip-and-wrap design in XrpcServer.#installWebSocketHandler needs updating.`
      )
    }
    nodeServer.removeListener('upgrade', atcuteListener)

    // Single wrapping listener. Non-XRPC upgrades fall through to other
    // listeners (Vite HMR, app-defined WS) without us touching the socket.
    nodeServer.on('upgrade', async (req, socket, head) => {
      if (!req.url?.startsWith('/xrpc/')) {
        // Not ours — let other 'upgrade' listeners handle. Critically, this
        // is the path Vite HMR's WebSocket upgrade takes in dev mode.
        //
        // Trade-off: because we snipped atcute's catch-all listener, a
        // non-XRPC upgrade with NO consumer-registered listener falls through
        // to Node's default behavior (destroy the socket) rather than getting
        // an explicit 404 like atcute used to send. Acceptable: with proper
        // consumer routing (Vite, app WS), this branch is never the last
        // resort.
        return
      }

      // Build a narrow RequestContext directly — no synthetic HttpContext.
      // appServer.createRequest uses the live app config (encryption, qsParser,
      // HTTP config) so HttpRequest.id() respects the consumer's
      // `generateRequestId` / `createRequestId` settings — request IDs stay
      // consistent with the HTTP-path generator within the same app. The
      // HttpRequest itself flows into the RequestContext so subscription
      // handlers can use `ctx.request.header(...)`, `ctx.request.input(...)`
      // (query params), `ctx.request.completeUrl()`, etc.
      const synthRes = new ServerResponse(req)
      const request = appServer.createRequest(req, synthRes)
      // Same fallback as `fromHttpContext` — keeps `RequestContext.requestId`
      // always a string regardless of consumer's `generateRequestId` setting.
      const requestId = request.id() ?? crypto.randomUUID()
      const logger = await this.#app.container.make('logger')
      const requestLogger = logger.child({ request_id: requestId })
      const containerResolver = this.#app.container.createResolver()

      // `enterWith` (not `run`) so the store survives the synchronous chain
      // when we delegate to atcute's captured listener (which awaits async
      // work in router.fetch — those continuations inherit our store via
      // async-hooks init snapshotting).
      requestContextStore.enterWith({
        requestId,
        request,
        logger: requestLogger,
        containerResolver,
      })

      await atcuteListener(req, socket, head)
    })
  }

  #installRoutes(xrpc: XrpcRouter): void {
    if (!xrpc.committed) {
      throw new RuntimeException(
        'XRPC builder must be committed before installing routes; call router.xrpc.commit() first'
      )
    }

    // One closure handler for all routes. atcute has no per-request extension
    // point; both paths bridge through `requestContextStore` (HTTP via the
    // dispatch middleware, WS via the upgrade listener), so the registered
    // handler just reads from it and passes the result through. The executor's
    // signature accepts `requestCtx?: RequestContext`; if `getStore()` returns
    // undefined here (i.e. a dispatch boundary skipped its `enterWith` /
    // `run`), the executor throws InternalServerError with a clear diagnostic
    // — no non-null assertion needed at this call site.
    const handler = (atcuteCtx: any) => this.#executor(atcuteCtx, requestContextStore.getStore())

    // Atcute's add* methods type the handler per route kind (Response for
    // procedure/query; AsyncIterable for subscription) — our shared closure
    // returns the union of both. Cast at the call sites; runtime dispatch
    // selects the correct branch via `lexicon.type` inside the executor.
    for (const route of xrpc.operations.values()) {
      switch (route.lexicon.type) {
        case 'xrpc_procedure':
          this.#router.addProcedure(route.lexicon as any, { handler: handler as any })
          break
        case 'xrpc_query':
          this.#router.addQuery(route.lexicon as any, { handler: handler as any })
          break
        case 'xrpc_subscription':
          this.#router.addSubscription(route.lexicon as any, { handler: handler as any })
          break
        default: {
          // Exhaustiveness — if the lexicon shape adds a new method type
          // (unlikely; the spec hasn't changed in years), this surfaces a
          // type error at compile time so we catch it before runtime.
          const exhaustive: never = route.lexicon as never
          throw new InternalServerError(
            `Unhandled XRPC lexicon type at install: ${String((exhaustive as any).type)}`
          )
        }
      }
    }
  }

  /**
   * @internal — test-only escape hatch for unit-testing `#installRoutes`
   * without needing a real container-bound Adonis router. Production code
   * goes through `start()`.
   */
  installRoutesForTesting(xrpc: XrpcRouter): void {
    this.#installRoutes(xrpc)
  }

  /** Read accessor for the dispatch middleware. */
  get router(): XRPCRouter {
    return this.#router
  }
}

export function createXrpcExecutor(deps: {
  operations: ReadonlyMap<string, RouteInfo>
  serializer: XrpcSerializer
  // ERROR-REPORTING SEAM (Plan 04): `xrpc: XrpcService` field added here.
}): SharedXrpcExecutor {
  const { operations, serializer } = deps

  // NOTE: this is intentionally a non-async function. Subscription routes
  // need to return an `AsyncIterable<unknown>` *directly* — atcute's
  // `for await (const message of handler(context))` doesn't unwrap a Promise.
  // HTTP routes return `Promise<Response>` from `XrpcContext.als.run(...)`.
  return (atcuteCtx, requestCtx) => {
    // `requestCtx` arrives materialized — by the HTTP dispatch middleware on
    // the procedure/query path, by `#installWebSocketHandler` on the WS path.
    // The registered atcute closure reads `requestContextStore.getStore()`
    // and passes it through. No ALS read inside the executor.
    //
    // The parameter is typed optional (`requestCtx?`) so the registered
    // closure doesn't need a non-null assertion at the call site. If
    // `getStore()` returns undefined here, a dispatch boundary failed to
    // populate the store — surface a precise diagnostic instead of a
    // downstream `undefined.requestId` TypeError.
    if (!requestCtx) {
      throw new InternalServerError(
        'XRPC executor invoked without a RequestContext — the dispatch boundary failed to populate requestContextStore'
      )
    }

    // Re-derive NSID from URL — atcute parses the NSID internally for route
    // lookup but doesn't expose it on the operation context. Slice matches
    // atcute's own internal slice (`/xrpc/`.length). `operations` is a
    // `ReadonlyMap`, so `operations.get('__proto__')` returns `undefined`
    // cleanly even on a crafted URL — no prototype-pollution lookup risk.
    const nsid = new URL(atcuteCtx.request.url).pathname.slice('/xrpc/'.length)
    const route = operations.get(nsid)
    if (!route) {
      // 404 is the right wire-level response — from the client's perspective
      // there's no such XRPC method on this server. The "atcute dispatched to
      // us but the registry doesn't know it" framing is preserved as
      // diagnostic context for logs; in normal operation atcute won't dispatch
      // unregistered NSIDs to us, so seeing this in production means either a
      // registry desync or a crafted URL that snuck past atcute's matcher.
      throw new NotFoundError(`No XRPC method registered for NSID '${nsid}'`)
    }

    const xrpcCtx = new XrpcContext({
      requestId: requestCtx.requestId,
      // Adonis HttpRequest; atcute's Fetch Request is internal
      request: requestCtx.request,
      logger: requestCtx.logger,
      containerResolver: requestCtx.containerResolver,
      lexicon: route.lexicon,
      input: 'input' in atcuteCtx ? atcuteCtx.input : undefined,
      params: atcuteCtx.params,
      signal: atcuteCtx.signal,
    })
    // `xrpcCtx.response` is constructed inside XrpcContext's constructor —
    // XrpcStream for subscription routes (signal threaded through),
    // XrpcResponse (with default state) for procedure/query.

    // `route.handler` is already the normalized form — Plan 01's
    // `XrpcRouter.#normalizeHandler` ran at register time, so eager class
    // refs went through fold's `moduleCaller` and lazy imports went through
    // `moduleImporter`. The executor just branches on `kind`.
    const invokeHandler = (ctx: XrpcContext<XrpcLexicon>): unknown =>
      route.handler.kind === 'function'
        ? route.handler.fn(ctx)
        : route.handler.handle(ctx.containerResolver, ctx)

    // HTTP path: enter the XrpcContext ALS scope and await the handler. The
    // `await` continuations re-enter the scope on each microtask boundary, so
    // downstream code calling `XrpcContext.getOrFail()` works as expected.
    //
    // Subscription path: DO NOT wrap the iterable's iteration in als.run here.
    // Async generators capture context at each `.next()` call, not at
    // construction. Returning the iterable out of `als.run` would put each
    // future `.next()` resumption in atcute's context (no store) — verified
    // empirically (Node 26). Instead, `wrapSubscriptionIterator` takes
    // `xrpcCtx` and re-enters the scope on each inner `.next()`.
    if (route.lexicon.type === 'xrpc_subscription') {
      // The handler() invocation that returns the AsyncIterable needs to run
      // inside als.run too — the handler may construct its iterator from
      // service calls that themselves read XrpcContext.
      const userIterable = XrpcContext.als.run(
        xrpcCtx,
        () => invokeHandler(xrpcCtx) as AsyncIterable<unknown>
      )
      return wrapSubscriptionIterator(userIterable, xrpcCtx, serializer)
    }

    return XrpcContext.als.run(xrpcCtx, async () => {
      try {
        const result = await invokeHandler(xrpcCtx)

        // atcute's router (verified against `xrpc-server/lib/main/router.ts`
        // on trunk, addQuery + addProcedure) inspects the handler's return
        // value with `output instanceof Response` and silently falls back to
        // `new Response(null)` for non-Response returns. We construct the
        // Response here so clients receive the actual serialized body.
        const respState = (xrpcCtx.response as { state: any }).state

        if (respState.redirect) {
          return Response.redirect(respState.redirect.url, respState.redirect.status)
        }

        // `.json(value)` override wins over the handler's return value.
        // The handler may have called .json() and then continued doing
        // post-response work (e.g. queueing a job) before returning void —
        // `bodySet` (not `body !== undefined`) is the discriminator so
        // `.json(null)` differs from "never called".
        const rawBody = respState.bodySet ? respState.body : result
        const serialized = await serializer.serializeWithoutWrapping(
          rawBody,
          xrpcCtx.containerResolver
        )
        return Response.json(serialized, {
          status: respState.status ?? 200,
          headers: respState.headers,
        })
      } catch (err: any) {
        const xrpcError =
          err instanceof XrpcError ? err : new InternalServerError(err?.message ?? String(err))
        // ERROR-REPORTING SEAM (Plan 04): call
        //   `await xrpc.getRegisteredErrorHandler()?.report(err, xrpcCtx)`
        // here (procedure/query path). The subscription branch in Task 4 has
        // the mirror seam for `getRegisteredSubscriptionErrorHandler()`.
        throw xrpcError
      }
    })
  }
}

/**
 * Wraps a user-provided async-generator subscription handler with a
 * transforming generator that:
 *
 * 1. Re-enters the `XrpcContext.als` scope on every inner `.next()` call so
 *    downstream code calling `XrpcContext.getOrFail()` from inside yields
 *    sees the current context. Async generators capture context at `.next()`
 *    time (NOT at construction); a one-shot `als.run` around iterator
 *    construction doesn't propagate.
 * 2. Pipes each yielded value through the XRPC serializer (so transformer
 *    contracts the user embedded — `Item` / `Collection` — get unpacked
 *    before atcute's framing layer encodes the message as a CBOR frame).
 *
 * On error, `XrpcError` instances are translated to `XRPCSubscriptionError`
 * so atcute's `handleSubscriptionException` hook emits the error frame and
 * closes the stream cleanly.
 */
async function* wrapSubscriptionIterator(
  iterable: AsyncIterable<unknown>,
  xrpcCtx: XrpcContext<XrpcLexicon>,
  serializer: XrpcSerializer
): AsyncGenerator<unknown> {
  // Only needs xrpcCtx — containerResolver (for serialization) and the full
  // context (for the error reporter) both live on XrpcContext.
  const inner = iterable[Symbol.asyncIterator]()
  try {
    while (true) {
      // Each .next() runs inside the XrpcContext ALS scope. The user's
      // generator body resumes inside this scope and any downstream
      // `XrpcContext.getOrFail()` call sees `xrpcCtx`. Async generators
      // capture context at .next() time, not construction.
      const result = await XrpcContext.als.run(xrpcCtx, () => inner.next())
      if (result.done) return
      // Serialization doesn't need to read XrpcContext via the ALS, so it
      // stays outside the scope — keeps the scope window tight to just
      // handler execution.
      yield await serializer.serializeWithoutWrapping(result.value, xrpcCtx.containerResolver)
    }
  } catch (err: any) {
    const xrpcError =
      err instanceof XrpcError
        ? err
        : new InternalServerError(err?.message ?? String(err), { cause: err })
    // ERROR-REPORTING SEAM (Plan 04): call
    //   `await xrpc.getRegisteredSubscriptionErrorHandler()?.report(err, xrpcCtx)`
    // here. Falls through to `getRegisteredErrorHandler()` when the
    // subscription-specific handler isn't registered.
    throw new XRPCSubscriptionError({
      error: xrpcError.errorName,
      message: xrpcError.message,
    })
  }
}
