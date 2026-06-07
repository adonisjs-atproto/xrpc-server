# Handler return type gap

## The problem

Inline handler return values are not typechecked against the lexicon's output schema.
A handler that returns `{}` when the lexicon requires `{ labels: Label[] }` passes
the TypeScript compiler silently:

```ts
router.xrpc.query(ComAtprotoLabelQueryLabels, async (ctx) => {
  return {} // ← no error, even though `labels` is required
})
```

Caught at runtime when the client receives `{}` instead of `{ labels: [] }`.

## Why it happens

`XrpcHandlerInput` in `src/router/types.ts` is typed as `(ctx: any) => any`. The
`any` return type is deliberate — the handler form is a union of three shapes
(inline function, eager class constructor, lazy import tuple), and threading a
lexicon generic `L` through all three without losing controller-class dispatch
safety is non-trivial. The executor collects the return value as `unknown`
(line 88 of `src/executor.ts`) and treats it as an untyped raw body.

## Where the type safety does exist

`XrpcResponse<L>.json(value: InferOutput<L>)` in `src/response.ts` is fully typed.
A handler that uses `ctx.response.json({})` gets a compile error when `{}` doesn't
satisfy `InferOutput<L>`. The gap only applies to the **return value** path.

## The two response paths

The executor gives equal precedence to both:

```ts
// Path A — return value (untyped)
const result = await invokeHandler(xrpcCtx)

// Path B — ctx.response.json() (typed against InferOutput<L>)
const rawBody = respState.bodySet ? respState.body : result
```

`bodySet` is the discriminant: if `.json()` was called, its value wins; otherwise
the return value is used. Both reach the wire, but only path B is typechecked.

## Ideal fix

Narrow the inline function form of `XrpcHandlerInput` to return
`Promise<InferOutput<L> | void>`:

```ts
// Rough sketch — not yet implemented
type XrpcHandlerFn<L extends XrpcLexicon> = (ctx: XrpcContext<L>) => Promise<InferOutput<L> | void>
```

`void` covers the `ctx.response.json()` path (handler returns nothing; executor
reads `respState.body`). `InferOutput<L>` covers the return-value path.

The difficulty: `XrpcRouter.procedure/query/subscription()` are generic on `L`,
so the handler argument would also need to be `XrpcHandlerFn<L>`. Controller-class
and lazy-import forms would need separate typed overloads or remain `any`. This is
achievable but adds complexity to the public API surface.

## Until then

Prefer `ctx.response.json(value)` over `return value` in handlers — it is typed
and will catch shape mismatches at compile time. The return-value path is
convenient for simple cases but provides no compile-time safety.
