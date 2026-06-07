import { RuntimeException } from '@adonisjs/core/exceptions'
import { XrpcOperationContext, type XrpcOperationContextParams } from './operation.ts'
import { XrpcResponse } from '../response.ts'
import type {
  InferInput,
  InferParams,
  LexiconInput,
  ResolveLexicon,
  XrpcProcedureLexicon,
  XrpcQueryLexicon,
} from '../types.ts'

/**
 * Constructor parameters for XrpcHttpContext. Extends the base params with
 * lexicon, params, and input — the L-parameterized fields that distinguish
 * an HTTP operation context from the abstract base.
 */
export interface XrpcHttpContextParams<L extends XrpcQueryLexicon | XrpcProcedureLexicon>
  extends XrpcOperationContextParams {
  lexicon: L
  params: InferParams<L>
  input: InferInput<L>
}

/**
 * Operation context for query + procedure routes. Carries `response`
 * (XrpcResponse<L> — the buffered response-state slot the executor reads
 * after the handler resolves), plus the lexicon-typed `lexicon`, `params`,
 * and `input` fields.
 *
 * The `type` discriminator narrows to 'query' | 'procedure' (assigned from
 * lexicon.type at construction); subscription contexts have `type ===
 * 'subscription'`.
 */
export class XrpcHttpContext<
  L extends XrpcQueryLexicon | XrpcProcedureLexicon = XrpcQueryLexicon | XrpcProcedureLexicon,
> extends XrpcOperationContext {
  /**
   * Read the current XRPC HTTP context from the shared ALS. Returns undefined
   * if there's no active scope OR if the active scope is a subscription
   * (instanceof check narrows to HTTP-kind).
   *
   * The T generic accepts either a bare lexicon schema or a namespace
   * wrapper (`LexiconInput<L>`) — same shape `router.xrpc.procedure / query`
   * take for registration. ResolveLexicon<T> unwraps the namespace form so
   * the returned context's lexicon-typed fields are precise.
   *
   * The T assertion is NOT runtime-verified against the actual scope's
   * lexicon — instanceof only verifies HTTP-kind. Caller-assertion semantics
   * apply (same trade-off as `as XrpcHttpContext<L>`).
   */
  static get<
    T extends LexiconInput<XrpcQueryLexicon | XrpcProcedureLexicon> =
      | XrpcQueryLexicon
      | XrpcProcedureLexicon,
  >(): XrpcHttpContext<ResolveLexicon<T>> | undefined {
    const ctx = XrpcOperationContext.als.getStore()
    return ctx instanceof XrpcHttpContext
      ? (ctx as XrpcHttpContext<ResolveLexicon<T>>)
      : undefined
  }

  static getOrFail<
    T extends LexiconInput<XrpcQueryLexicon | XrpcProcedureLexicon> =
      | XrpcQueryLexicon
      | XrpcProcedureLexicon,
  >(): XrpcHttpContext<ResolveLexicon<T>> {
    const ctx = XrpcHttpContext.get<T>()
    if (!ctx) {
      throw new RuntimeException(
        'XrpcHttpContext is not available — called outside an XRPC HTTP handler scope'
      )
    }
    return ctx
  }

  readonly type: 'query' | 'procedure'
  readonly lexicon: L
  readonly params: InferParams<L>
  readonly input: InferInput<L>
  readonly response: XrpcResponse<L>

  constructor(params: XrpcHttpContextParams<L>) {
    super(params)
    this.lexicon = params.lexicon
    this.params = params.params
    this.type = params.lexicon.type === 'xrpc_query' ? 'query' : 'procedure'
    this.input = params.input
    this.response = new XrpcResponse<L>()
  }
}
