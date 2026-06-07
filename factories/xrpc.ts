import { HttpContextFactory } from '@adonisjs/core/factories/http'
import type { HttpRequest } from '@adonisjs/core/http'
import type { Logger } from '@adonisjs/core/logger'
import type { ContainerResolver } from '@adonisjs/core/container'
import { XrpcHttpContext, XrpcSubscriptionContext, type XrpcContext } from '../src/context/main.js'
import type {
  InferInput,
  InferParams,
  XrpcLexicon,
  XrpcProcedureLexicon,
  XrpcQueryLexicon,
  XrpcSubscriptionLexicon,
} from '../src/types.js'

interface MergeParams<L extends XrpcLexicon> {
  lexicon: L
  request: HttpRequest
  input: unknown
  params: Record<string, any>
  signal: AbortSignal
  logger: Logger
  containerResolver: ContainerResolver<any>
  requestId: string
}

/**
 * Test-facing builder for XRPC contexts. Carries sensible defaults for every
 * field — tests merge only the fields that matter for the assertion under
 * test, parallel to Adonis's HttpContextFactory. Defaults derive from a
 * fresh HttpContextFactory().create() (same source the production HTTP-path
 * materialization uses via fromHttpContext() in Plan 03), so test fixtures
 * stay aligned with real dispatch.
 *
 * `create()` is overloaded so the inferred lexicon kind picks the concrete
 * subclass return type at the call site. The runtime branches on
 * `lexicon.type` to construct the matching subclass.
 */
export class XrpcContextFactory {
  #params: Partial<MergeParams<XrpcLexicon>> = {}

  merge(params: Partial<MergeParams<XrpcLexicon>>): this {
    this.#params = { ...this.#params, ...params }
    return this
  }

  // Overload 1: subscription lexicons → XrpcSubscriptionContext.
  create<L extends XrpcSubscriptionLexicon>(): XrpcSubscriptionContext<L>
  // Overload 2: query/procedure lexicons → XrpcHttpContext.
  create<L extends XrpcQueryLexicon | XrpcProcedureLexicon>(): XrpcHttpContext<L>
  // Overload 3 (wide fallback): the union alias for callers passing the
  // wide XrpcLexicon constraint.
  create<L extends XrpcLexicon>(): XrpcContext<L>
  /**
   * Construct the context. **An explicit type argument is required to get a
   * typed concrete subclass** — without one, TypeScript resolves overload 3
   * (the wide union), and the result typed as `XrpcContext<XrpcLexicon>`:
   *
   * @example
   * // ✅ Typed: ctx is XrpcHttpContext<XrpcProcedureLexicon>
   * factory.merge({ lexicon: myProc }).create<XrpcProcedureLexicon>()
   *
   * // ⚠️ Wide union: ctx is XrpcContext<XrpcLexicon> — no .response / .stream
   * factory.merge({ lexicon: myProc }).create()
   */
  create<L extends XrpcLexicon>(): XrpcContext<L> {
    // No `as L` cast — discriminated-union narrowing on lexicon.type works
    // against the XrpcLexicon union naturally. The L parameterization is
    // confined to the return cast.
    const lexicon = this.#params.lexicon
    if (!lexicon) {
      throw new Error('XrpcContextFactory: lexicon is required — call .merge({ lexicon }) first')
    }

    const httpCtx = new HttpContextFactory().create()
    const shared = {
      request: this.#params.request ?? httpCtx.request,
      signal: this.#params.signal ?? new AbortController().signal,
      logger: this.#params.logger ?? httpCtx.logger,
      containerResolver: this.#params.containerResolver ?? httpCtx.containerResolver,
      requestId: this.#params.requestId ?? httpCtx.request.id() ?? 'test-req-id',
    }

    if (lexicon.type === 'xrpc_subscription') {
      // lexicon narrowed to XrpcSubscriptionLexicon via discriminated union.
      return new XrpcSubscriptionContext({
        ...shared,
        lexicon,
        params: (this.#params.params ?? {}) as InferParams<XrpcSubscriptionLexicon>,
      }) as XrpcContext<L>
    }

    // lexicon narrowed to XrpcQueryLexicon | XrpcProcedureLexicon.
    return new XrpcHttpContext({
      ...shared,
      lexicon,
      params: (this.#params.params ?? {}) as InferParams<XrpcQueryLexicon | XrpcProcedureLexicon>,
      input: this.#params.input as InferInput<XrpcQueryLexicon | XrpcProcedureLexicon>,
    }) as XrpcContext<L>
  }
}
