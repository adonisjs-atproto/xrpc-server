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
import type { XrpcSerializer } from './serializer.js'
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

/**
 * Stub. Real implementation lands in Task 3.
 */
export function createXrpcExecutor(_deps: {
  operations: ReadonlyMap<string, RouteInfo>
  serializer: XrpcSerializer
  // ERROR-REPORTING SEAM (Plan 04): `xrpc: XrpcService` field added here.
}): SharedXrpcExecutor {
  throw new RuntimeException('createXrpcExecutor() not yet implemented (Plan 03 Task 3)')
}
