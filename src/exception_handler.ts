import type { ApplicationService } from '@adonisjs/core/types'

import { XrpcError, InternalServerError } from './errors.js'
import type { XrpcContext } from './context.js'
import type { XrpcLexicon } from './types.js'

/**
 * Base class for XRPC exception handlers. Consumers' app/exceptions/xrpc_handler.ts
 * extends this; Plan 04's XrpcService.errorHandler(factory) resolves the
 * consumer's subclass lazily on first error.
 *
 * Ships three methods:
 *  - shouldReport(error) — defaults to true. Override to suppress
 *    reporting for specific errors (validation failures the consumer
 *    doesn't want to log, etc.).
 *  - report(error, ctx)  — defaults to no-op. Override to add Sentry,
 *    structured logging, custom metrics, etc.
 *  - handle(error, ctx)  — returns the XrpcError that atcute will
 *    wire-encode as the response body. Defaults: XrpcError instances
 *    pass through unchanged; unexpected errors become a generic
 *    InternalServerError in production (no leak), or are wrapped in
 *    InternalServerError with { cause } in development.
 *
 * The handler's constructor receives the ApplicationService via the
 * container (when Plan 04's XrpcService.getRegisteredErrorHandler()
 * resolves the registered subclass via app.container.make(mod.default)) —
 * this.app.inProduction drives the production-vs-development branch.
 */
export class ExceptionHandler {
  constructor(protected app: ApplicationService) {}

  /**
   * Override to suppress reporting for specific errors. Default: true
   * (report everything).
   */
  shouldReport(_error: unknown): boolean {
    return true
  }

  /**
   * Observation hook (Sentry, structured logging, custom metrics).
   * Default: no-op. Consumers add their reporting code by overriding.
   *
   * ctx is null for atcute-internal errors raised before the dispatch
   * executor materializes an XrpcContext (request parsing failures,
   * etc.) — guard with ctx?.lexicon.nsid etc.
   */
  async report(_error: unknown, _ctx: XrpcContext<XrpcLexicon> | null): Promise<void> {
    // No-op by default.
  }

  /**
   * Sanitize the error before atcute encodes it. Default behavior:
   *  - XrpcError instances pass through unchanged (already wire-shaped
   *    with stable errorName + safe message).
   *  - In production, unexpected errors are replaced with a generic
   *    InternalServerError('Internal Server Error') — preserves the
   *    500-level status without leaking internal messages / stacks.
   *  - In development, the original error's message is preserved on the
   *    InternalServerError along with { cause: error } so developers
   *    can see the root cause in logs and clients see something useful.
   *
   * Override to customize sanitization. Call super.handle(error, ctx)
   * to keep the env-aware default behavior and layer custom logic on top.
   */
  async handle(error: unknown, _ctx: XrpcContext<XrpcLexicon> | null): Promise<XrpcError> {
    if (error instanceof XrpcError) return error
    if (this.app.inProduction) {
      return new InternalServerError('Internal Server Error')
    }
    return new InternalServerError(error instanceof Error ? error.message : String(error), {
      cause: error,
    })
  }
}
