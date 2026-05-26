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
import type { Socket } from 'node:net'
import { RuntimeException } from '@adonisjs/core/exceptions'
import type { ApplicationService } from '@adonisjs/core/types'
import type { Server as AdonisServer } from '@adonisjs/core/http'

import type { XrpcRouter, RouteInfo } from './router/index.js'
import type { XrpcLexicon } from './types.js'
import type { XrpcSerializer } from './serializer.js'
import { XrpcContext } from './context.js'
import { XrpcError, InternalServerError, NotFoundError } from './errors.js'
import { type RequestContext, requestContextStore } from './request_context.js'
import { type XrpcService, REPORTED } from './xrpc_service.js'

// Forward type-only references to atcute. Imports stay type-only so this
// module's *runtime* dependency surface is just the constructor names; the
// actual `XRPCRouter` / `createNodeWebSocket` instances are constructed by
// the provider (Plan 04) and passed into `XrpcServer`'s constructor.
import { XRPCSubscriptionError } from '@atcute/xrpc-server'
import type { XRPCRouter } from '@atcute/xrpc-server'
import type { createNodeWebSocket } from '@atcute/xrpc-server-node'
import type { WebSocketServer } from 'ws'

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
  #shuttingDown = false

  /**
   * Atcute's captured 'upgrade' listener, snipped from the Node server and
   * stored here so the wrapper field `#upgradeListener` can delegate to it
   * after the `#shuttingDown` guard. Populated by `#installWebSocketHandler`
   * before any upgrades can arrive.
   */
  #atcuteUpgradeListener: ((req: http.IncomingMessage, socket: Socket, head: Buffer) => Promise<void>) | null = null

  /**
   * The upgrade wrapper registered on the Node server. Checks `#shuttingDown`
   * first — when `shutdown()` sets the flag, in-flight upgrade negotiations
   * are rejected (socket destroyed) so new clients don't connect during the
   * grace window. On the normal path, delegates to `#atcuteUpgradeListener`
   * after injecting the `RequestContext` into `requestContextStore`.
   *
   * Defined as a class field so `this` is lexically bound and the listener
   * can be referenced (for `removeListener`) in shutdown without needing a
   * stable outside reference.
   */
  #upgradeListener = async (req: http.IncomingMessage, socket: Socket, head: Buffer): Promise<void> => {
    if (this.#shuttingDown) {
      // Reject the upgrade by destroying the socket. The handshake hasn't
      // completed yet, so there's no WebSocket frame to send — destroying
      // the underlying TCP socket is the right signal. The client sees
      // ECONNRESET and should retry against the new pod (post-shutdown).
      socket.destroy()
      return
    }
    if (!req.url?.startsWith('/xrpc/')) {
      // Not ours — let other 'upgrade' listeners handle.
      return
    }
    const synthRes = new ServerResponse(req)
    const appServer = await this.#app.container.make('server')
    const request = appServer.createRequest(req, synthRes)
    const requestId = request.id() ?? crypto.randomUUID()
    const logger = await this.#app.container.make('logger')
    const requestLogger = logger.child({ request_id: requestId })
    const containerResolver = this.#app.container.createResolver()
    requestContextStore.enterWith({
      requestId,
      request,
      logger: requestLogger,
      containerResolver,
    })
    await this.#atcuteUpgradeListener!(req, socket, head)
  }

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
  #installWebSocketHandler(nodeServer: http.Server, _appServer: AdonisServer): void {
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

    // Store atcute's listener so the class-field `#upgradeListener` can
    // delegate to it after injecting RequestContext + checking #shuttingDown.
    this.#atcuteUpgradeListener = atcuteListener

    // Register the single wrapping listener. Non-XRPC upgrades pass through;
    // shutting-down state rejects new clients; #upgradeListener handles the
    // rest including RequestContext injection and atcute delegation.
    nodeServer.on('upgrade', this.#upgradeListener)
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
   * Gracefully shut down all active WebSocket (subscription) connections.
   *
   * 1. Flip `#shuttingDown` — the upgrade wrapper starts rejecting new
   *    connections immediately.
   * 2. Send 1001 "Going Away" to every connected client. This lets well-
   *    behaved clients exit their read loops cleanly (they receive the close
   *    frame and drain their async generators) rather than waiting for a
   *    ping timeout (typically 30s).
   * 3. Wait up to `graceMs` for all clients to ack the close. Each ack
   *    removes the client from `wss.clients`; we poll until the set is
   *    empty or the grace window expires.
   * 4. Force-terminate any survivors (non-acking or misbehaving clients)
   *    via `.terminate()`, which kills the underlying TCP socket without
   *    sending a frame.
   *
   * Called from the `app.terminating(...)` hook registered in `ready()` —
   * must run BEFORE Adonis's own HTTP-server `.close()` hook (LIFO order
   * ensures this when registered last). See the Plan 04 amendments block
   * for the full ordering analysis.
   *
   * `graceMs` defaults to 3000ms. To-do: expose via `defineConfig` when a
   * consumer with unusually long-running subscription handlers turns up.
   */
  async shutdown(graceMs = 3000): Promise<void> {
    this.#shuttingDown = true

    // No connected clients — nothing to drain.
    if (this.#ws.wss.clients.size === 0) return

    // Send 1001 "Going Away" to every connected client. Snapshot to
    // Array.from before iterating — `.close()` may synchronously remove the
    // client from `wss.clients` and skew direct Set iteration.
    for (const client of Array.from(this.#ws.wss.clients)) {
      try {
        client.close(1001, 'server shutting down')
      } catch {
        // Already closed / closing — ignore.
      }
    }

    // Wait briefly for clients to ack the close.
    await waitForAllClientsClosed(this.#ws.wss, graceMs)

    // Force-terminate any survivors. `.terminate()` kills the TCP socket
    // without sending a frame. Survivors are misbehaving clients or
    // subscription handlers stuck past the grace window.
    for (const client of Array.from(this.#ws.wss.clients)) {
      try {
        client.terminate()
      } catch {
        // Already terminated — ignore.
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

/**
 * Poll until `wss.clients` is empty or the grace window expires.
 * `.unref()` on the internal timer prevents the poller from holding the
 * process open if shutdown stalls — Node's event loop exits when only
 * `.unref()`'d timers remain.
 */
async function waitForAllClientsClosed(wss: WebSocketServer, graceMs: number): Promise<void> {
  if (wss.clients.size === 0) return
  return new Promise((resolve) => {
    const start = Date.now()
    const check = () => {
      if (wss.clients.size === 0) return resolve()
      if (Date.now() - start >= graceMs) return resolve()
      setTimeout(check, 50).unref()
    }
    check()
  })
}

export function createXrpcExecutor(deps: {
  operations: ReadonlyMap<string, RouteInfo>
  serializer: XrpcSerializer
  xrpc: XrpcService
}): SharedXrpcExecutor {
  const { operations, serializer, xrpc } = deps

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
      return wrapSubscriptionIterator(userIterable, xrpcCtx, xrpc, serializer)
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
        throw await runConsumerHandler(xrpc, err, xrpcCtx)
      }
    })
  }
}

/**
 * Run the consumer's registered ExceptionHandler against an error. Used
 * by both the procedure/query executor catch and the subscription wrapper
 * catch — single source of truth for the report → handle → mark sequence.
 *
 * Returns the XrpcError the caller should throw. Stamps the `REPORTED`
 * symbol so atcute's HTTP-path `handleException` hook (Plan 04 Task 4's
 * `makeAtcuteHttpHook`) skips a duplicate handler invocation when the
 * sanitized error bubbles up to atcute's exception handler.
 *
 * Fallback (no handler registered): wrap non-XrpcError as
 * InternalServerError with `{ cause }` — preserves the Plan 03 default
 * for tests and consumers who haven't wired `start/kernel.ts` yet.
 */
async function runConsumerHandler(
  xrpc: XrpcService,
  err: unknown,
  xrpcCtx: XrpcContext<XrpcLexicon>
): Promise<XrpcError> {
  const handler = await xrpc.getRegisteredErrorHandler()

  if (handler) {
    // Reporting first — fire-and-forget for the wire response. A reporter
    // that throws gets logged but doesn't mask the original error.
    if (handler.shouldReport(err)) {
      try {
        await handler.report(err, xrpcCtx)
      } catch (reportErr) {
        xrpcCtx.logger.error(
          { err: reportErr },
          'XRPC ExceptionHandler.report() itself threw — proceeding with handle()'
        )
      }
    }

    // Sanitization — the returned XrpcError is what gets wire-encoded.
    const sanitized = await handler.handle(err, xrpcCtx)
    ;(sanitized as any)[REPORTED] = true
    return sanitized
  }

  // No handler registered — fall back to the Plan 03 default wrap.
  const fallback =
    err instanceof XrpcError
      ? err
      : new InternalServerError(err instanceof Error ? err.message : String(err), { cause: err })
  ;(fallback as any)[REPORTED] = true
  return fallback
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
  xrpc: XrpcService,
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
    const xrpcError = await runConsumerHandler(xrpc, err, xrpcCtx)

    // Translate XrpcError → XRPCSubscriptionError. Atcute has no
    // configurable subscription-error hook — it inspects the thrown value:
    // XRPCSubscriptionError → emit error frame + close with err.closeCode;
    // anything else → close 1011 + invoke onSocketError (telemetry-only).
    // The sanitized XrpcError from runConsumerHandler carries the wire-
    // shape `errorName` + `message` we want for the error frame.
    throw new XRPCSubscriptionError({
      error: xrpcError.errorName,
      message: xrpcError.message,
    })
  }
}
