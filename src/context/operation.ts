import { AsyncLocalStorage } from 'node:async_hooks'
import Macroable from '@poppinss/macroable'
import { RuntimeException } from '@adonisjs/core/exceptions'
import type { HttpRequest } from '@adonisjs/core/http'
import type { Logger } from '@adonisjs/core/logger'
import type { ContainerResolver } from '@adonisjs/core/container'

/**
 * Constructor parameters for the abstract base. Non-generic — only the
 * cross-cutting fields whose types don't depend on the lexicon.
 * Subclass params (XrpcHttpContextParams / XrpcSubscriptionContextParams)
 * extend this with lexicon, params, and kind-specific fields.
 */
export interface XrpcOperationContextParams {
  request: HttpRequest
  signal: AbortSignal
  logger: Logger
  containerResolver: ContainerResolver<any>
  requestId: string
}

/**
 * Abstract base for XRPC operation contexts. Non-generic: lexicon-typed
 * fields (lexicon, params, response/stream, input) live on the concrete
 * subclasses. The base holds only request-scoped cross-cutting state plus
 * the shared AsyncLocalStorage that the executor writes once per request.
 *
 * Subclass-typed accessors (XrpcHttpContext.getOrFail / XrpcSubscriptionContext.getOrFail)
 * read this same ALS and `instanceof`-narrow on read. The base's own
 * `getOrFail()` returns this non-generic reference, suitable for
 * context-agnostic infrastructure code (logger access, exception reporting).
 */
export abstract class XrpcOperationContext extends Macroable {
  static readonly als = new AsyncLocalStorage<XrpcOperationContext>()

  static get(): XrpcOperationContext | undefined {
    return XrpcOperationContext.als.getStore()
  }

  static getOrFail(): XrpcOperationContext {
    const ctx = XrpcOperationContext.als.getStore()
    if (!ctx) {
      throw new RuntimeException(
        'XrpcOperationContext is not available — called outside an XRPC handler scope'
      )
    }
    return ctx
  }

  abstract readonly type: 'query' | 'procedure' | 'subscription'

  readonly request: HttpRequest
  readonly signal: AbortSignal
  readonly logger: Logger
  readonly containerResolver: ContainerResolver<any>
  readonly requestId: string

  protected constructor(params: XrpcOperationContextParams) {
    super()
    this.request = params.request
    this.signal = params.signal
    this.logger = params.logger
    this.containerResolver = params.containerResolver
    this.requestId = params.requestId
  }
}
