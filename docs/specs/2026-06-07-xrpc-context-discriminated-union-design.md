# `XrpcContext` discriminated-union refactor — design

**Status:** Draft — awaiting review
**Date:** 2026-06-07
**Subject:** Split the single `XrpcContext<L>` class into a discriminated union of `XrpcHttpContext` (query + procedure) and `XrpcSubscriptionContext`, anchored on an abstract `XrpcOperationContext<L>` base.
**Builds on:** [`2026-05-19-adonisjs-atproto-xrpc-design.md`](./2026-05-19-adonisjs-atproto-xrpc-design.md) (canonical package design).

## Summary

`XrpcContext<L>` currently models procedure / query / subscription dispatch as a single class whose `response` property has a conditional type — `L extends XrpcSubscriptionLexicon ? XrpcStream<L> : XrpcResponse<L>`. TypeScript can't reduce that conditional at the call site when `L` is a free generic, so handler-adjacent code (and tests) must cast `ctx.response as XrpcResponse<any>` to use it. The Task 8 review in Plan 03 surfaced this friction and the `xrpc-context-response-narrowing` memory note flagged it for resolution before Plan 03/04 lands consumer-facing examples.

This spec reshapes the type as a textbook discriminated union: an abstract base class holding shared request-scoped state, and two concrete subclasses — `XrpcHttpContext` (query + procedure) carrying `response: XrpcResponse<L>`, and `XrpcSubscriptionContext` carrying `stream: XrpcStream<L>`. The public `XrpcContext<L>` symbol becomes a type alias that resolves to the concrete subclass based on the lexicon kind. The narrowing-by-cast pattern disappears: a handler annotated `(ctx: XrpcContext<typeof myProcedureLex>)` is directly typed as `XrpcHttpContext`, and `ctx.response` is reachable without narrowing.

A single `AsyncLocalStorage` lives on the abstract base. Each subclass exposes typed `static get() / getOrFail()` accessors that read the shared storage and narrow via `instanceof` — so consumers get one of three access patterns:

- `XrpcOperationContext.getOrFail()` — returns the union; for code that only reads shared fields (logger, containerResolver) and doesn't care which kind of handler scope it's in. The existing `XrpcContext.get()` callers in `providers/provider.ts` (exception reporting) fall into this bucket.
- `XrpcHttpContext.getOrFail()` — returns the narrowed `XrpcHttpContext`; throws cleanly if called from a subscription scope.
- `XrpcSubscriptionContext.getOrFail()` — symmetric.

The change is type-shape-only: runtime behavior (executor branching, ALS-scope semantics, error-handler reporter signatures, serializer pass-through) is preserved.

## Motivation

Three concrete problems with the current single-class shape, in order of pain:

1. **Conditional property types don't narrow.** `XrpcContext<L>.response` is conditionally typed, and TypeScript only reduces the conditional when `L` is a concrete type satisfying the `extends` clause. In practice that means: (a) inside the executor where `L` is `XrpcLexicon` (wide), `ctx.response` is the unreduced conditional and unusable; (b) in `tests/context.spec.ts`, even with concrete lexicons, the construction helper's generic propagation forced casts to `XrpcResponse<any>` to assert response state. The casts paper over the friction but don't fix it.

2. **`response`-vs-`stream` is two unrelated concerns sharing one slot.** Today both live in the same property under conditional typing. A future plugin author writing `.macro('paginate', ...)` on `XrpcResponse` has no place to attach a parallel `.macro('keepalive', ...)` on `XrpcStream` that doesn't pollute the response API for HTTP handlers. Splitting the contexts cleanly separates the Macroable extension surfaces.

3. **The class invariant "subscription state and HTTP state never coexist" is communicated by `lexicon.type` checks scattered through the executor.** A discriminated-union representation lifts that invariant to the type system: a function that takes `XrpcHttpContext` is statically known to be unreachable from a subscription handler, no `if` needed.

The cost of the refactor is local — single-package, no released consumers (per `xrpc-package-spec-status` memory: Plan 04 is paused at pre-flight; the labeler consumer hasn't migrated yet). Doing it now before Plan 04 ships handler-author guidance is the cheap window.

## Architecture

### File layout

The current `src/context.ts` becomes a directory mirroring the `src/router/` convention (`main.ts` entrypoint, scoped filenames without the `xrpc_` prefix):

```
src/
└── context/
    ├── operation.ts      — XrpcOperationContext<L> (abstract base, ALS, shared fields)
    ├── http.ts           — XrpcHttpContext<L> (query + procedure)
    ├── subscription.ts   — XrpcSubscriptionContext<L>
    └── main.ts           — re-exports + the XrpcContext<L> type alias
```

`src/context.ts` is removed. Callers update their imports from `./context.js` to `./context/main.js`. The package's `index.ts` re-export point (`./src/context.js`) becomes `./src/context/main.js`.

### Class shape

```ts
// src/context/operation.ts

export abstract class XrpcOperationContext<L extends XrpcLexicon> extends Macroable {
  // Single storage for both subclasses. Executor writes once per request;
  // subclass-typed accessors instanceof-narrow on read.
  static readonly als = new AsyncLocalStorage<XrpcOperationContext<XrpcLexicon>>()

  static get(): XrpcOperationContext<XrpcLexicon> | undefined {
    return XrpcOperationContext.als.getStore()
  }

  static getOrFail(): XrpcOperationContext<XrpcLexicon> {
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
  readonly lexicon: L
  readonly params: InferParams<L>
  readonly signal: AbortSignal
  readonly logger: Logger
  readonly containerResolver: ContainerResolver<any>
  readonly requestId: string

  protected constructor(params: XrpcOperationContextParams<L>) {
    super()
    this.request = params.request
    this.lexicon = params.lexicon
    this.params = params.params
    this.signal = params.signal
    this.logger = params.logger
    this.containerResolver = params.containerResolver
    this.requestId = params.requestId
  }
}
```

```ts
// src/context/http.ts

export class XrpcHttpContext<
  L extends XrpcQueryLexicon | XrpcProcedureLexicon = XrpcQueryLexicon | XrpcProcedureLexicon,
> extends XrpcOperationContext<L> {
  // Shadow the base's accessors with subclass-typed returns. Both read the
  // shared XrpcOperationContext.als; the instanceof check is what narrows.
  static get(): XrpcHttpContext | undefined {
    const ctx = XrpcOperationContext.als.getStore()
    return ctx instanceof XrpcHttpContext ? ctx : undefined
  }

  static getOrFail(): XrpcHttpContext {
    const ctx = XrpcHttpContext.get()
    if (!ctx) {
      throw new RuntimeException(
        'XrpcHttpContext is not available — called outside an XRPC HTTP handler scope'
      )
    }
    return ctx
  }

  readonly type: 'query' | 'procedure'
  readonly input: InferInput<L>
  readonly response: XrpcResponse<L>

  constructor(params: XrpcHttpContextParams<L>) {
    super(params)
    this.type = params.lexicon.type === 'xrpc_query' ? 'query' : 'procedure'
    this.input = params.input
    this.response = new XrpcResponse<L>()
  }
}
```

```ts
// src/context/subscription.ts

export class XrpcSubscriptionContext<
  L extends XrpcSubscriptionLexicon = XrpcSubscriptionLexicon,
> extends XrpcOperationContext<L> {
  static get(): XrpcSubscriptionContext | undefined {
    const ctx = XrpcOperationContext.als.getStore()
    return ctx instanceof XrpcSubscriptionContext ? ctx : undefined
  }

  static getOrFail(): XrpcSubscriptionContext {
    const ctx = XrpcSubscriptionContext.get()
    if (!ctx) {
      throw new RuntimeException(
        'XrpcSubscriptionContext is not available — called outside an XRPC subscription handler scope'
      )
    }
    return ctx
  }

  readonly type = 'subscription' as const
  readonly stream: XrpcStream<L>

  constructor(params: XrpcSubscriptionContextParams<L>) {
    super(params)
    this.stream = new XrpcStream<L>(params.lexicon, params.signal)
  }
}
```

```ts
// src/context/main.ts

export { XrpcOperationContext } from './operation.js'
export { XrpcHttpContext } from './http.js'
export { XrpcSubscriptionContext } from './subscription.js'

// Public union-alias surface — what handler authors annotate with.
// Because TypeScript reduces conditional type aliases eagerly when L is
// concrete, `XrpcContext<typeof myProcedureLex>` resolves directly to
// `XrpcHttpContext<...>` at the handler site. No narrowing required.
export type XrpcContext<L extends XrpcLexicon> =
  L extends XrpcSubscriptionLexicon
    ? XrpcSubscriptionContext<L>
    : L extends XrpcQueryLexicon | XrpcProcedureLexicon
      ? XrpcHttpContext<L>
      : never
```

### Constructor parameters

Three parameter interfaces, paralleling the class hierarchy:

```ts
// Shared — lives in src/context/operation.ts with the base class.
interface XrpcOperationContextParams<L extends XrpcLexicon> {
  request: HttpRequest
  lexicon: L
  params: InferParams<L>
  signal: AbortSignal
  logger: Logger
  containerResolver: ContainerResolver<any>
  requestId: string
}

// HTTP — adds `input` (typed `InferInput<L>`, which is `undefined` for queries
// and the body for procedures).
interface XrpcHttpContextParams<L extends XrpcQueryLexicon | XrpcProcedureLexicon>
  extends XrpcOperationContextParams<L> {
  input: InferInput<L>
}

// Subscription — no extra params; XrpcStream is constructed from the lexicon
// and signal already on the base params.
interface XrpcSubscriptionContextParams<L extends XrpcSubscriptionLexicon>
  extends XrpcOperationContextParams<L> {}
```

The existing `XrpcContextParams<L>` interface is removed. Callers update to the appropriate subtype.

### ALS access patterns

| Use case | Call | Returns |
|---|---|---|
| Context-agnostic read (logger, containerResolver, requestId) — typically infrastructure code that doesn't care which kind of handler scope it's in | `XrpcOperationContext.getOrFail()` | `XrpcOperationContext<XrpcLexicon>` (the union); shared fields directly typed |
| HTTP-handler-side service code that needs `ctx.response` | `XrpcHttpContext.getOrFail()` | `XrpcHttpContext`; throws if currently in a subscription scope |
| Subscription-handler-side service code that needs `ctx.stream` | `XrpcSubscriptionContext.getOrFail()` | `XrpcSubscriptionContext`; throws if currently in an HTTP scope |

The throw on wrong-kind access is intentional: a service that calls `XrpcHttpContext.getOrFail()` from a subscription scope is incorrectly composed, and a loud failure beats a silent `undefined`.

### Macroable

Macroable extension surfaces split with the class hierarchy:

- `XrpcOperationContext.macro(name, fn)` — applies to both subclasses (inherited static). Use for additions that read only shared fields (e.g., a logging shorthand that reads `this.logger`).
- `XrpcHttpContext.macro(name, fn)` — applies to HTTP context only. Use for additions that read `this.response`.
- `XrpcSubscriptionContext.macro(name, fn)` — applies to subscription context only. Use for additions that read `this.stream`.

The existing `tests/context.spec.ts:151` macro test (`'XrpcContext / XrpcResponse / XrpcStream expose static .macro'`) becomes a test that all three classes expose `.macro` and that base-class macros propagate to subclass instances.

### Executor changes

`src/executor.ts` already branches on `route.lexicon.type === 'xrpc_subscription'` (line 104). The branch now also picks the subclass to instantiate, but uses the same shared ALS:

```ts
// src/executor.ts (sketch — only the changed lines shown)

if (route.lexicon.type === 'xrpc_subscription') {
  const xrpcCtx = new XrpcSubscriptionContext({
    requestId: requestCtx.requestId,
    request: requestCtx.request,
    logger: requestCtx.logger,
    containerResolver: requestCtx.containerResolver,
    lexicon: route.lexicon,
    params: atcuteCtx.params,
    signal: atcuteCtx.signal,
  })
  const userIterable = XrpcOperationContext.als.run(
    xrpcCtx,
    () => invokeHandler(xrpcCtx) as AsyncIterable<unknown>
  )
  return wrapSubscriptionIterator(userIterable, xrpcCtx, xrpc, serializer)
}

const xrpcCtx = new XrpcHttpContext({
  requestId: requestCtx.requestId,
  request: requestCtx.request,
  logger: requestCtx.logger,
  containerResolver: requestCtx.containerResolver,
  lexicon: route.lexicon as XrpcQueryLexicon | XrpcProcedureLexicon,
  input: 'input' in atcuteCtx ? atcuteCtx.input : undefined,
  params: atcuteCtx.params,
  signal: atcuteCtx.signal,
})
return XrpcOperationContext.als.run(xrpcCtx, async () => { /* same body as today */ })
```

`wrapSubscriptionIterator` updates its parameter type from `XrpcContext<XrpcLexicon>` to `XrpcSubscriptionContext`, and the inner `.next()` ALS re-entry uses `XrpcOperationContext.als.run(...)` (the shared base ALS — same instance, just a different exporting class). `runConsumerHandler` updates its parameter type to `XrpcOperationContext<XrpcLexicon>` (the union — it only reads shared fields like `logger`).

## Migration impact

### Callers to update

| File | Change |
|---|---|
| `src/executor.ts` | Branch on lexicon kind picks subclass; `XrpcContext.als` → `XrpcOperationContext.als`. |
| `src/exception_handler.ts` | Type-only import — `XrpcContext` → `XrpcOperationContext` for the union case, or the concrete subclass for kind-specific reporters. |
| `providers/provider.ts:208,255` | `XrpcContext.get() ?? null` → `XrpcOperationContext.get() ?? null`. (Reports run against either kind; the union is correct.) |
| `index.ts:15` | `export { XrpcContext } from './src/context.js'` → re-export the three concrete classes + the `XrpcContext` type alias from `./src/context/main.js`. |
| `factories/xrpc.ts` (`XrpcContextFactory`) | `create()` becomes an overloaded method that narrows its return type based on the inferred lexicon kind — see [Factory narrowing](#factory-narrowing) below. Runtime branches on `lexicon.type` to construct the right subclass. |
| `tests/context.spec.ts` | Reorganise: split into `tests/context/operation.spec.ts`, `tests/context/http.spec.ts`, `tests/context/subscription.spec.ts`. The ALS / Macroable tests move to the operation spec; the response-state tests move to http; the stream tests move to subscription. The cast workaround in the construction helper goes away. |
| `tests/xrpc_server.spec.ts:288,297` | `XrpcContext.als.getStore()` → `XrpcOperationContext.als.getStore()`. (The test is about ALS scope re-entry inside subscription iteration; it doesn't care about narrowing.) |
| `tests/provider_error_reporting.spec.ts:36,40` | `XrpcContext<XrpcLexicon> \| null` → `XrpcOperationContext<XrpcLexicon> \| null` in the reporter signature. |
| `tests/factory.spec.ts:3` | `XrpcContext` type ref updates to whichever concrete class the factory returns. |

### Factory narrowing

`XrpcContextFactory.create()` today is a single signature returning `XrpcContext<L>`:

```ts
create<L extends XrpcLexicon>(): XrpcContext<L>
```

That signature relies on the consumer asserting `L` at the call site (`factory.create<typeof myProcedureLex>()`). With the union-alias `XrpcContext<L>`, this *does* resolve to the concrete subclass when `L` is concrete — but TypeScript can't propagate the runtime `lexicon.type` check back to `L` inside the body, so the construction site needs a cast no matter what.

The right shape is overload signatures — one per lexicon-kind constraint, plus a wide implementation signature. TypeScript picks the most specific overload based on the inferred `L`, so callers get the narrowed concrete type without a cast on their side:

```ts
// factories/xrpc.ts

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
  // Overload 3 (wide fallback): preserves the existing XrpcContext<L> entry point.
  create<L extends XrpcLexicon>(): XrpcContext<L>
  // Implementation signature.
  create<L extends XrpcLexicon>(): XrpcContext<L> {
    const lexicon = this.#params.lexicon as L | undefined
    if (!lexicon) {
      throw new Error('XrpcContextFactory: lexicon is required — call .merge({ lexicon }) first')
    }

    const httpCtx = new HttpContextFactory().create()
    const shared = {
      lexicon,
      request: this.#params.request ?? httpCtx.request,
      params:
        (this.#params.params as unknown as InferParams<L>) ?? ({} as unknown as InferParams<L>),
      signal: this.#params.signal ?? new AbortController().signal,
      logger: this.#params.logger ?? httpCtx.logger,
      containerResolver: this.#params.containerResolver ?? httpCtx.containerResolver,
      requestId: this.#params.requestId ?? httpCtx.request.id() ?? 'test-req-id',
    }

    if (lexicon.type === 'xrpc_subscription') {
      return new XrpcSubscriptionContext({
        ...shared,
        lexicon: lexicon as XrpcSubscriptionLexicon,
      }) as XrpcContext<L>
    }

    return new XrpcHttpContext({
      ...shared,
      lexicon: lexicon as XrpcQueryLexicon | XrpcProcedureLexicon,
      input: (this.#params.input as unknown as InferInput<L>) ?? (undefined as any),
    }) as XrpcContext<L>
  }
}
```

Call-site behavior:

```ts
const subCtx = new XrpcContextFactory()
  .merge({ lexicon: subscribeLabels })
  .create<typeof subscribeLabels>()        // → XrpcSubscriptionContext<typeof subscribeLabels>

const procCtx = new XrpcContextFactory()
  .merge({ lexicon: createReport, input: { ... } })
  .create<typeof createReport>()           // → XrpcHttpContext<typeof createReport>

const wide = new XrpcContextFactory()
  .merge({ lexicon })
  .create()                                // → XrpcContext<XrpcLexicon> (the union)
```

The two casts inside the implementation (`as XrpcContext<L>` at each return) are the contained price of the runtime branch — TypeScript verifies they're sound against the wide implementation signature; the overloads are what give callers the narrowed type without any cast on their side.

### Behavioral parity

The runtime behavior change is zero — the executor still constructs a context, runs the handler inside an ALS scope, and reads `response.state` (HTTP) or iterates the user's `AsyncIterable` (subscription) the same way. The only runtime difference is **which class** is constructed in each branch; the ALS storage, the scope semantics, and the serializer pass-through are unchanged.

### Memory / context-narrowing follow-up

The `xrpc-context-response-narrowing` memory note is superseded by this refactor. Once this lands, that memory should be deleted (per the global memory rule on point-in-time observations becoming stale). The follow-up of "consider narrowing helpers" is resolved by the discriminated union itself — no `isProcedureContext` / `isSubscriptionContext` predicate helpers needed.

## Out of scope

- **Renaming `XrpcContext`.** The public type alias keeps the name `XrpcContext<L>` for handler-author ergonomics. Consumers writing `(ctx: XrpcContext<typeof myLex>) => ...` don't need to know whether the lexicon is a query/procedure/subscription — the alias resolves correctly.
- **Top-level `getXrpcContext()` helper.** The base class IS the coordinator; `XrpcOperationContext.getOrFail()` is the single entry point. No free-function wrapper.
- **Changes to `XrpcResponse` / `XrpcStream`.** Those classes are unchanged. Only the wrapping `XrpcContext` is restructured.
- **Plan 04 (auth) integration.** The auth-related additions to context (Plan 05) attach to whichever subclass needs them. Out of scope here.

## Open questions

None remaining — the discussion converged on: discriminated union via abstract base + two subclasses, single shared ALS on the base, subclass-typed `.get() / .getOrFail()` accessors narrowing via `instanceof`, file layout under `src/context/` mirroring `src/router/`.
