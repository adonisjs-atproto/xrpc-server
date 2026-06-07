import { XrpcHttpContext } from './http.ts'
import { XrpcSubscriptionContext } from './subscription.ts'
import type { XrpcOperationContext } from './operation.ts'

/**
 * Narrows a context reference to `XrpcHttpContext`. Useful when consumer
 * code holds an `XrpcOperationContext` (or the wide `XrpcContext<XrpcLexicon>`
 * union) and needs to read `.response` / `.input` / lexicon-typed fields.
 *
 * Generic over `Ctx` so the narrowing preserves whatever refinement the
 * caller already had — `Ctx & XrpcHttpContext` keeps the inferred lexicon
 * parameter on the narrowed result instead of collapsing to the default-L
 * `XrpcHttpContext`.
 */
export function isHttpContext<Ctx extends XrpcOperationContext>(
  ctx: Ctx
): ctx is Ctx & XrpcHttpContext {
  return ctx instanceof XrpcHttpContext
}

/**
 * Narrows a context reference to `XrpcSubscriptionContext`. Symmetric to
 * `isHttpContext` — for code that needs to read `.stream` or
 * subscription-lexicon-typed fields. Also generic over `Ctx` to preserve L.
 */
export function isSubscriptionContext<Ctx extends XrpcOperationContext>(
  ctx: Ctx
): ctx is Ctx & XrpcSubscriptionContext {
  return ctx instanceof XrpcSubscriptionContext
}
