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

import { RuntimeException } from '@adonisjs/core/exceptions'
import type { ApplicationService } from '@adonisjs/core/types'

import type { RouteInfo } from './router/index.js'
import type { XrpcLexicon } from './types.js'
import type { XrpcSerializer } from './serializer.js'
import { XrpcContext } from './context.js'
import { XrpcError, InternalServerError, NotFoundError } from './errors.js'
import { type RequestContext } from './request_context.js'

// Forward type-only references to atcute. Imports stay type-only so this
// module's *runtime* dependency surface is just the constructor names; the
// actual `XRPCRouter` / `createNodeWebSocket` instances are constructed by
// the provider (Plan 04) and passed into `XrpcServer`'s constructor.
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
) => Promise<Response | AsyncIterable<unknown>>

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
    // Reference fields so TS6133 doesn't fire on the stub; Tasks 5–6 wire them in.
    void this.#app
    void this.#ws
    void this.#executor
    throw new RuntimeException('XrpcServer.start() not yet implemented (Plan 03 Task 5)')
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

  return async (atcuteCtx, requestCtx) => {
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

/** Stub. Real implementation lands in Task 4. */
// eslint-disable-next-line require-yield
async function* wrapSubscriptionIterator(
  _iterable: AsyncIterable<unknown>,
  _xrpcCtx: XrpcContext<XrpcLexicon>,
  _serializer: XrpcSerializer
): AsyncGenerator<unknown> {
  throw new RuntimeException('wrapSubscriptionIterator() not yet implemented (Plan 03 Task 4)')
}
