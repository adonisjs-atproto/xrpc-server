/*
|--------------------------------------------------------------------------
| RequestContext — narrow per-request scope for the XRPC executor
|--------------------------------------------------------------------------
|
| The dispatch executor receives a `RequestContext` as its second argument.
| It carries just the request-scoped primitives the executor and downstream
| handler need — not a full HttpContext.
|
| atcute's router has no per-request extension point, so both paths populate
| the same package-internal ALS (`requestContextStore`) at the dispatch
| boundary: the HTTP dispatch middleware enters it before calling
| `xrpcRouter.fetch(...)` (with a RequestContext materialized from the
| triggering HttpContext via `fromHttpContext`); the WS upgrade listener
| enters it before delegating to atcute's captured listener (with a
| RequestContext built directly from the upgrade IncomingMessage + app).
| The registered atcute closure reads `requestContextStore.getStore()` for
| either path and threads it into the executor explicitly.
|
| No synthetic HttpContext is constructed on the WS path;
| `useAsyncLocalStorage: true` in `config/app.ts` is NOT required.
*/

import { AsyncLocalStorage } from 'node:async_hooks'
import type { HttpContext, HttpRequest } from '@adonisjs/core/http'
import type { Logger } from '@adonisjs/core/logger'
import type { ContainerResolver } from '@adonisjs/core/container'

/**
 * The narrow per-request scope passed to the executor as `requestCtx`.
 */
export type RequestContext = {
  requestId: string
  // Adonis — surfaces on XrpcContext.request so handlers can use
  // validateUsing / input / header / completeUrl / etc.
  request: HttpRequest
  logger: Logger
  containerResolver: ContainerResolver<any>
}

/**
 * Package-internal ALS that bridges the dispatch boundary (HTTP middleware
 * or WS upgrade listener) to the registered atcute closure. The executor
 * itself does NOT read from this store; it receives `requestCtx` explicitly.
 */
export const requestContextStore = new AsyncLocalStorage<RequestContext>()

/**
 * Materializes a `RequestContext` from an Adonis HttpContext. Used by the
 * HTTP-path dispatch middleware to enter `requestContextStore` before
 * calling `xrpcRouter.fetch(...)`.
 *
 * Falls back to crypto.randomUUID() if HttpRequest.id() returns undefined
 * (consumer set `generateRequestId: false` or no x-request-id header on
 * the request) — keeps RequestContext.requestId: string invariant for
 * downstream code.
 */
export function fromHttpContext(httpCtx: HttpContext): RequestContext {
  return {
    requestId: httpCtx.request.id() ?? crypto.randomUUID(),
    request: httpCtx.request,
    logger: httpCtx.logger,
    containerResolver: httpCtx.containerResolver,
  }
}
