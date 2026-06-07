import { RuntimeException } from '@adonisjs/core/exceptions'
import { XrpcOperationContext, type XrpcOperationContextParams } from './operation.ts'
import { XrpcStream } from '../stream.ts'
import type {
  InferParams,
  LexiconInput,
  ResolveLexicon,
  XrpcSubscriptionLexicon,
} from '../types.ts'

/**
 * Constructor parameters for XrpcSubscriptionContext. Extends the base
 * params with lexicon and params; XrpcStream is constructed from the
 * lexicon + signal inside the subclass constructor.
 */
export interface XrpcSubscriptionContextParams<
  L extends XrpcSubscriptionLexicon,
> extends XrpcOperationContextParams {
  lexicon: L
  params: InferParams<L>
}

/**
 * Operation context for subscription routes. Carries `stream`
 * (XrpcStream<L> — the message builder + signal-mirror used by async
 * generators), plus the lexicon-typed `lexicon` and `params`.
 *
 * The `type` discriminator is the literal 'subscription'.
 */
export class XrpcSubscriptionContext<
  L extends XrpcSubscriptionLexicon = XrpcSubscriptionLexicon,
> extends XrpcOperationContext {
  /**
   * Read the current XRPC subscription context from the shared ALS. Returns
   * undefined if no active scope or if the active scope is HTTP.
   *
   * The T generic accepts either a bare lexicon schema or a namespace
   * wrapper (`LexiconInput<L>`) — same shape `router.xrpc.subscription`
   * takes for registration. Caller-assertion semantics for L (same trade-
   * off as XrpcHttpContext.get / getOrFail — see those doc comments).
   */
  static get<T extends LexiconInput<XrpcSubscriptionLexicon> = XrpcSubscriptionLexicon>():
    | XrpcSubscriptionContext<ResolveLexicon<T>>
    | undefined {
    const ctx = XrpcOperationContext.als.getStore()
    return ctx instanceof XrpcSubscriptionContext
      ? (ctx as XrpcSubscriptionContext<ResolveLexicon<T>>)
      : undefined
  }

  static getOrFail<
    T extends LexiconInput<XrpcSubscriptionLexicon> = XrpcSubscriptionLexicon,
  >(): XrpcSubscriptionContext<ResolveLexicon<T>> {
    const ctx = XrpcSubscriptionContext.get<T>()
    if (!ctx) {
      throw new RuntimeException(
        'XrpcSubscriptionContext is not available — called outside an XRPC subscription handler scope'
      )
    }
    return ctx
  }

  readonly type = 'subscription' as const
  readonly lexicon: L
  readonly params: InferParams<L>
  readonly stream: XrpcStream<L>

  constructor(params: XrpcSubscriptionContextParams<L>) {
    super(params)
    this.lexicon = params.lexicon
    this.params = params.params
    this.stream = new XrpcStream<L>(params.lexicon, params.signal)
  }
}
