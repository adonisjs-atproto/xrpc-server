import type { Container, ContainerResolver } from '@adonisjs/core/container'
import type {
  InferOutput,
  MessageOf,
  XrpcLexicon,
  XrpcProcedureLexicon,
  XrpcQueryLexicon,
  XrpcSubscriptionLexicon,
} from '../types.ts'
import type { XrpcContext, XrpcHttpContext, XrpcSubscriptionContext } from '../context/main.ts'

// Inline minimal aliases for types that live in transitive deps not exposed
// under nodenext resolution from our direct dep set.
export type AnyConstructor = new (...args: any[]) => any
export type AnyLazyImport = () => Promise<{ default: AnyConstructor }>

/**
 * Derive a handler's allowed return shape from its lexicon kind.
 *
 *  - subscription lexicons → `AsyncIterable<MessageOf<L>>` (the handler
 *    must produce a typed message stream)
 *  - query / procedure lexicons → `InferOutput<L> | void` (the handler
 *    may return the response body directly, or return nothing after
 *    writing the body via `ctx.response.json()`)
 *
 * The constraint is what makes `async *list()` invalid as a query
 * handler — the inferred return is `AsyncGenerator`, not `InferOutput<L>`.
 *
 * Two parameterizations for the same rule:
 *  - `HandlerReturnFor<L>` — when you have the lexicon directly (used in
 *    `NormalizedHandler<L>` / `XrpcHandlerInput<L>`).
 *  - `HandlerReturnFromCtx<Ctx>` — when you have the context and want to
 *    extract L from it (used by the executor's `invokeHandler` generic).
 */
export type HandlerReturnFor<L extends XrpcLexicon> = L extends XrpcSubscriptionLexicon
  ? AsyncIterable<MessageOf<L>>
  : L extends XrpcQueryLexicon | XrpcProcedureLexicon
    ? InferOutput<L> | void
    : never

export type HandlerReturnFromCtx<Ctx> = Ctx extends
  | XrpcSubscriptionContext<infer L>
  | XrpcHttpContext<infer L>
  ? HandlerReturnFor<L>
  : never

// XrpcContext<L> resolves to the concrete subclass per lexicon kind:
// XrpcHttpContext<L> for query/procedure, XrpcSubscriptionContext<L> for
// subscription. Default L = XrpcLexicon distributes to give the full union.
// Handler return is constrained to HandlerReturnFor<L> (or a Promise of it)
// so consumers get type errors for mismatched shapes (e.g. async generator
// in a query handler).
export type XrpcHandlerInput<L extends XrpcLexicon = XrpcLexicon> =
  | ((ctx: XrpcContext<L>) => HandlerReturnFor<L> | Promise<HandlerReturnFor<L>>)
  | [AnyLazyImport | AnyConstructor, string?]

export type NormalizedHandler<L extends XrpcLexicon = XrpcLexicon> =
  | {
      kind: 'function'
      fn: (ctx: XrpcContext<L>) => HandlerReturnFor<L> | Promise<HandlerReturnFor<L>>
    }
  | {
      kind: 'controller'
      name: string
      // toHandleMethod() always wraps the controller call in a Promise.
      // For HTTP handlers this resolves to InferOutput<L> | void; for
      // subscription handlers it resolves to the AsyncIterable<MessageOf<L>>
      // the method returns. wrapSubscriptionIterator awaits the Promise
      // before iterating.
      handle: (
        resolver: Container<any> | ContainerResolver<any>,
        ctx: XrpcContext<L>
      ) => Promise<HandlerReturnFor<L>>
    }

/**
 * A registered route's lexicon paired with its normalized handler. The
 * handler is typed with `NormalizedHandler<any>` rather than a per-route L
 * because the operations Map stores routes after registration-time L erasure.
 *
 * Using `any` (rather than `XrpcLexicon`) avoids the cast at storage time:
 * `NormalizedHandler<L>` is assignable to `NormalizedHandler<any>` via
 * `any`'s bivariance, where `NormalizedHandler<XrpcLexicon>` would require
 * a cast because the distributed-union form fights the per-route L. The
 * executor narrows on `lexicon.type` at dispatch and re-introduces the
 * lexicon-implied return shape via its own `HandlerReturn<Ctx>` derivation.
 */
export interface RouteInfo {
  lexicon: XrpcLexicon
  handler: NormalizedHandler<any>
}
