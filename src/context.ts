import { AsyncLocalStorage } from 'node:async_hooks'
import Macroable from '@poppinss/macroable'
import { RuntimeException } from '@adonisjs/core/exceptions'
import type { HttpRequest } from '@adonisjs/core/http'
import type { Logger } from '@adonisjs/core/logger'
import type { ContainerResolver } from '@adonisjs/core/container'
import type {
  InferInput,
  InferOutput,
  InferParams,
  MessageOf,
  XrpcLexicon,
  XrpcMessagePayload,
  XrpcMessageRef,
  XrpcSubscriptionLexicon,
} from './types.js'

/**
 * Output channel for procedure / query handlers. Buffers response state
 * locally (status / headers / body / redirect) — the dispatch executor
 * (Plan 03) reads .state after the handler resolves and constructs the
 * wire Response (atcute's router checks output instanceof Response and
 * silently drops non-Response returns, so the executor MUST construct one).
 *
 * Macroable so plugin packages can attach declarative response methods.
 *
 * For subscriptions, this class is not used — XrpcStream lives in the same
 * ctx.response slot for that path.
 *
 * @internal — instances constructed by XrpcContext's constructor (which
 * branches on lexicon.type).
 */
export class XrpcResponse<L extends XrpcLexicon> extends Macroable {
  readonly state: {
    status?: number
    headers: Headers
    body?: InferOutput<L>
    bodySet: boolean
    redirect?: { url: string; status: 301 | 302 | 303 | 307 | 308 }
  }

  constructor() {
    super()
    this.state = { headers: new Headers(), bodySet: false }
  }

  status(code: number): this {
    this.state.status = code
    return this
  }

  header(name: string, value: string): this {
    this.state.headers.set(name, value)
    return this
  }

  json(value: InferOutput<L>): this {
    this.state.body = value
    this.state.bodySet = true
    return this
  }

  redirect(url: string, status: 301 | 302 | 303 | 307 | 308 = 302): this {
    this.state.redirect = { url, status }
    return this
  }
}

/**
 * Output channel for subscription handlers. The handler yields the values
 * returned from message(ref, payload); the dispatch executor (Plan 03)
 * pipes each one through the serializer before atcute frames it on the wire.
 *
 * @internal — instances constructed by dispatch.
 */
export class XrpcStream<L extends XrpcSubscriptionLexicon> extends Macroable {
  constructor(
    private lexicon: L,
    public readonly signal: AbortSignal
  ) {
    super()
  }

  get aborted(): boolean {
    return this.signal.aborted
  }

  message<R extends XrpcMessageRef<L>>(ref: R, payload: XrpcMessagePayload<L, R>): MessageOf<L> {
    return {
      $type: `${this.lexicon.nsid}${ref}`,
      ...payload,
    } as unknown as MessageOf<L>
  }
}

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
