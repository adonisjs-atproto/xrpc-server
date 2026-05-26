import { RuntimeException } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

import { XrpcServer } from '../xrpc_server.js'
import { requestContextStore, fromHttpContext } from '../request_context.js'
import { adonisRequestToWebRequest, writeWebResponseToAdonisResponse } from '../utils.js'

/**
 * Server-level middleware mounted in `start/kernel.ts`'s `server.use([...])`
 * chain. Intercepts `/xrpc/*` requests and dispatches them through atcute's
 * `XRPCRouter`. Non-matching paths fall through to the next middleware.
 *
 * The middleware resolves `XrpcServer` from the per-request container (the
 * provider in Plan 04 binds it as a singleton — same instance on every
 * request). Resolving per-request lets future plans inject a per-test or
 * per-tenant XrpcServer via container scoping; in production it's always
 * the same singleton.
 *
 * The middleware is also the HTTP-path entry into `requestContextStore`: it
 * materializes a `RequestContext` from the triggering `HttpContext`
 * (via `fromHttpContext(ctx)`) and runs `xrpcRouter.fetch(...)` inside
 * `requestContextStore.run(...)`. The registered atcute closure then reads
 * `requestContextStore.getStore()` and threads it into the executor.
 */
export default class XrpcDispatchMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (!ctx.request.url().startsWith('/xrpc/')) {
      return next()
    }

    let xrpcServer: XrpcServer
    try {
      xrpcServer = await ctx.containerResolver.make(XrpcServer)
    } catch (err) {
      throw new RuntimeException(
        'XrpcServer is not bound in the container — provider may not have booted (Plan 04 wires this)',
        { cause: err as Error }
      )
    }

    const webRequest = adonisRequestToWebRequest(ctx.request)
    const webResponse = await requestContextStore.run(fromHttpContext(ctx), () =>
      xrpcServer.router.fetch(webRequest)
    )
    return writeWebResponseToAdonisResponse(webResponse, ctx.response)
  }
}
