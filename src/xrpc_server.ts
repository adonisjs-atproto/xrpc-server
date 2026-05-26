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
import { ServerResponse } from 'node:http'
import type { ApplicationService } from '@adonisjs/core/types'
import type { Server as AdonisServer } from '@adonisjs/core/http'
import type { XRPCRouter } from '@atcute/xrpc-server'
import type { createNodeWebSocket } from '@atcute/xrpc-server-node'
import type http from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebSocketServer } from 'ws'

import type { XrpcRouter } from './router/index.js'
import type { SharedXrpcExecutor } from './executor.ts'
import { InternalServerError } from './errors.js'
import { requestContextStore } from './request_context.js'

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
   * Atcute's bare 'upgrade' listener, obtained from `ws.createUpgradeListener`
   * (@atcute/xrpc-server-node@2.1.0+). Stored here so `#upgradeListener` can
   * delegate to it after injecting RequestContext + checking `#shuttingDown`.
   * Populated by `#installWebSocketHandler` before any upgrades can arrive.
   */
  #atcuteUpgradeListener:
    | ((req: http.IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>)
    | null = null

  /**
   * The upgrade wrapper registered on the Node server. URL-filters first so
   * the `#shuttingDown` guard is scoped to XRPC connections only (non-XRPC
   * upgrades — Vite HMR, in-app WS routes — pass through immediately).
   * On the XRPC path, rejects new connections during shutdown, then injects
   * `RequestContext` into `requestContextStore` before delegating to atcute.
   *
   * Defined as a class field so `this` is lexically bound and the listener
   * identity is stable for `removeListener` in shutdown.
   */
  #upgradeListener = async (
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> => {
    // Not an XRPC path — let other listeners (Vite HMR, in-app WS) handle.
    // `createUpgradeListener` guards this too, but checking here keeps the
    // #shuttingDown logic scoped to XRPC connections only.
    if (!req.url?.startsWith('/xrpc/')) return

    if (this.#shuttingDown) {
      // Reject the upgrade by destroying the socket. The handshake hasn't
      // completed yet, so there's no WebSocket frame to send — destroying
      // the underlying TCP socket is the right signal. The client sees
      // ECONNRESET and should retry against the new pod (post-shutdown).
      socket.destroy()
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
   * dispatch path.
   *
   * @atcute/xrpc-server-node@2.1.0 added `createUpgradeListener` — it returns
   * the bare listener without attaching it to the server, expressly so callers
   * can wrap it in their own context (e.g. `AsyncLocalStorage.run`) before
   * delegating. That is exactly what `#upgradeListener` does here: inject
   * `RequestContext` into `requestContextStore` and guard `#shuttingDown`
   * before calling the atcute listener.
   *
   * `createUpgradeListener` internally filters to `/xrpc/*` — non-XRPC
   * upgrades are returned early so other listeners (Vite HMR, in-app WS
   * routes) remain unaffected. `#upgradeListener` redundantly checks the
   * prefix too, so the `#shuttingDown` path is scoped to XRPC connections.
   */
  #installWebSocketHandler(nodeServer: http.Server, _appServer: AdonisServer): void {
    this.#atcuteUpgradeListener = this.#ws.createUpgradeListener(this.#router)
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
    // `atcuteCtx: any` is intentional — this closure is registered with three
    // add* methods whose handler signatures are structurally incompatible
    // (ProcedureContext / QueryContext / SubscriptionContext all differ in
    // shape and return type). The `as any` casts at each call site are the
    // explicit escape. `(ProcedureConfig<any> | QueryConfig<any>)['handler']`
    // resolves to a *function type* (not a context type) and doesn't cover
    // subscriptions, so it's not a useful annotation here.
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
   * 4. Force-terminate any survivors (clients that did not ack the close)
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
