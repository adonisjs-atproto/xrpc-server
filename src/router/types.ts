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

// Generic lazy import that preserves the controller class type T through the
// Promise. T is inferable from `() => import('./controller')` because TS sees
// the import's default export as the constructor. This mirrors AdonisJS's
// `LazyImport<T>` from @poppinss/utils/types — same pattern so the same
// inference benefits apply (the import expression's default constructor type
// is captured at the registration site without forcing the user to write the
// type explicitly).
export type AnyLazyImport<T extends AnyConstructor = AnyConstructor> = () => Promise<{
  default: T
}>

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

/**
 * Extract the union of method names on `Controller` whose signature
 * structurally matches an XRPC handler for lexicon `L` — i.e. accepts any
 * context argument (loosely typed at the method definition site is fine)
 * and returns the iterability shape the lexicon kind requires:
 *
 *   - subscription L → method must return `AsyncIterable<any>` or a Promise
 *     resolving to one (an `async function*` method or async method returning
 *     an iterable).
 *   - query / procedure L → method must NOT return an `AsyncIterable` —
 *     plain values, void, Blob, or Promises of those.
 *
 * The structural iterability check is looser than matching `MessageOf<L>` /
 * `InferOutput<L>` exactly, but tight enough to catch the common protocol
 * mistake: registering a non-iterable method on a subscription lexicon (or
 * vice versa). Strict message-type validation would require controllers to
 * type their methods against the lexicon — useful when consumers do, but
 * forces every test stub to import lexicon types.
 *
 * Mirrors AdonisJS's `GetControllerHandlers<Controller>` pattern from
 * `@adonisjs/http-server`, extended with the lexicon-kind iterability split.
 */
export type GetXrpcControllerHandlers<
  Controller extends AnyConstructor,
  L extends XrpcLexicon,
> = L extends XrpcSubscriptionLexicon
  ? {
      // Subscription: method's return must extend AsyncIterable.
      [K in Extract<keyof InstanceType<Controller>, string>]: InstanceType<Controller>[K] extends (
        ctx: XrpcSubscriptionContext<L>
      ) => AsyncIterable<any> | Promise<AsyncIterable<any>>
        ? K
        : never
    }[Extract<keyof InstanceType<Controller>, string>]
  : L extends XrpcQueryLexicon | XrpcProcedureLexicon
    ? {
        // Query / procedure: method's return must NOT be an AsyncIterable.
        // Expressed positively as "extends HandlerReturnFor<L> without the
        // AsyncIterable case." Since HandlerReturnFor<HTTP-L> doesn't include
        // AsyncIterable anyway, this is just the HTTP return shape.
        [K in Extract<
          keyof InstanceType<Controller>,
          string
        >]: InstanceType<Controller>[K] extends (
          ctx: XrpcHttpContext<L>
        ) => HandlerReturnFor<L> | Promise<HandlerReturnFor<L>>
          ? K
          : never
      }[Extract<keyof InstanceType<Controller>, string>]
    : never

/**
 * Handler input accepted by `router.xrpc.{query,procedure,subscription}`.
 * Either an inline function (typed via `HandlerReturnFor<L>`) or a
 * `[Controller, 'method']` tuple where the method name is constrained to
 * methods on the controller whose signature matches the lexicon's protocol.
 *
 * The `T` generic captures the controller class type so the tuple's second
 * element narrows to only the lexicon-valid method names. Without T (default
 * `AnyConstructor`), the second element falls back to the wide `string?`
 * — preserves backward compatibility for callers that pass `[Controller,
 * 'method']` without a generic argument.
 *
 * For a lazy-import form `[() => import('./controller'), 'method']`, TS
 * infers T from the import's default export, so validation works the same.
 */
export type XrpcHandlerInput<
  L extends XrpcLexicon = XrpcLexicon,
  T extends AnyConstructor = AnyConstructor,
> =
  | ((ctx: XrpcContext<L>) => HandlerReturnFor<L> | Promise<HandlerReturnFor<L>>)
  | [AnyLazyImport<T> | T, GetXrpcControllerHandlers<T, L>?]

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
