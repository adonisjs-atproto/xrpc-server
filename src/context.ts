import { AsyncLocalStorage } from 'node:async_hooks'
import Macroable from '@poppinss/macroable'
import { RuntimeException } from '@adonisjs/core/exceptions'
import type { HttpRequest } from '@adonisjs/core/http'
import type { Logger } from '@adonisjs/core/logger'
import type { ContainerResolver } from '@adonisjs/core/container'
import type { InferInput, InferParams, XrpcLexicon, XrpcSubscriptionLexicon } from './types.js'
import { XrpcResponse } from './response.js'
import { XrpcStream } from './stream.js'

export interface XrpcContextParams<L extends XrpcLexicon> {
  lexicon: L
  request: HttpRequest
  input: L extends XrpcSubscriptionLexicon ? undefined : InferInput<L>
  params: InferParams<L>
  signal: AbortSignal
  logger: Logger
  containerResolver: ContainerResolver<any>
  requestId: string
}

export class XrpcContext<L extends XrpcLexicon> extends Macroable {
  static readonly als = new AsyncLocalStorage<XrpcContext<XrpcLexicon>>()

  static get(): XrpcContext<XrpcLexicon> | undefined {
    return XrpcContext.als.getStore()
  }

  static getOrFail(): XrpcContext<XrpcLexicon> {
    const ctx = XrpcContext.als.getStore()
    if (!ctx) {
      throw new RuntimeException(
        'XrpcContext is not available — called outside an XRPC handler scope'
      )
    }
    return ctx
  }

  readonly request: HttpRequest
  readonly lexicon: L
  readonly input: L extends XrpcSubscriptionLexicon ? undefined : InferInput<L>
  readonly params: InferParams<L>
  readonly signal: AbortSignal
  readonly response: L extends XrpcSubscriptionLexicon ? XrpcStream<L> : XrpcResponse<L>

  readonly logger: Logger
  readonly containerResolver: ContainerResolver<any>
  readonly requestId: string

  /** @internal — instances constructed by dispatch or XrpcContextFactory. */
  constructor(params: XrpcContextParams<L>) {
    super()
    this.lexicon = params.lexicon
    this.request = params.request
    this.input = params.input
    this.params = params.params
    this.signal = params.signal
    this.logger = params.logger
    this.containerResolver = params.containerResolver
    this.requestId = params.requestId

    this.response = (
      params.lexicon.type === 'xrpc_subscription'
        ? new XrpcStream(params.lexicon as L & XrpcSubscriptionLexicon, params.signal)
        : new XrpcResponse<L>()
    ) as XrpcContext<L>['response']
  }
}
