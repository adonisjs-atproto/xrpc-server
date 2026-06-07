import type {
  XrpcLexicon,
  XrpcProcedureLexicon,
  XrpcQueryLexicon,
  XrpcSubscriptionLexicon,
} from '../types.ts'
import type { XrpcHttpContext } from './http.ts'
import type { XrpcSubscriptionContext } from './subscription.ts'

export { XrpcOperationContext, type XrpcOperationContextParams } from './operation.ts'
export { XrpcHttpContext, type XrpcHttpContextParams } from './http.ts'
export { XrpcSubscriptionContext, type XrpcSubscriptionContextParams } from './subscription.ts'
export { isHttpContext, isSubscriptionContext } from './helpers.ts'

/**
 * Public union-alias surface — what handler authors annotate with.
 *
 * TypeScript reduces conditional type aliases eagerly when L is a
 * concrete type, so `XrpcContext<typeof myProcedureLex>` resolves directly
 * to `XrpcHttpContext<...>` at the handler site — `.response` is directly
 * accessible without narrowing.
 *
 * For wide L (e.g. `XrpcContext<XrpcLexicon>`), the conditional distributes
 * over the lexicon union, yielding a distributed union. Use this form in
 * signatures that accept any kind of context.
 *
 * **Narrowing caveat:** Do NOT pass `XrpcContext<XrpcLexicon>` to
 * `isHttpContext` / `isSubscriptionContext` — the intersection
 * `XrpcContext<XrpcLexicon> & XrpcHttpContext` collapses to `never` because
 * the distributed union includes `XrpcSubscriptionContext` which has a
 * conflicting `type` literal. Use `XrpcOperationContext` as the parameter
 * type for code that needs to narrow via the predicates:
 *
 * @example
 * // ✅ Works — base type as parameter
 * function process(ctx: XrpcOperationContext) {
 *   if (isHttpContext(ctx)) ctx.response  // XrpcOperationContext & XrpcHttpContext
 * }
 *
 * // ⚠️ Narrows to `never` — distributed alias as parameter
 * function broken(ctx: XrpcContext<XrpcLexicon>) {
 *   if (isHttpContext(ctx)) ctx.response  // never
 * }
 */
export type XrpcContext<L extends XrpcLexicon> = L extends XrpcSubscriptionLexicon
  ? XrpcSubscriptionContext<L>
  : L extends XrpcQueryLexicon | XrpcProcedureLexicon
    ? XrpcHttpContext<L>
    : never
