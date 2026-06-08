---
'@thisismissem/adonisjs-atproto-xrpc': minor
---

**Type-level handler validation at registration** — `router.xrpc.{procedure,query,subscription}` now rejects handlers whose shape doesn't match the lexicon's protocol, catching mistakes at compile time that previously only surfaced at runtime.

```ts
// Subscription handler must return an AsyncIterable
router.xrpc.subscription(myLex, async () => ({ id: 'x' }))
//                              ^^^^^^^^^^^^^^^^^^^^^^^^^^
// Type error: Property '[Symbol.asyncIterator]' is missing

// Query / procedure handler can't be an async generator
router.xrpc.query(myLex, async function* () { yield 'x' })
//                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
// Type error: AsyncGenerator is not assignable to InferOutput<L> | void
```

**Controller-form handlers are also validated** — the method-name slot in `[Controller, 'method']` registration tuples is constrained to controller methods whose return matches the lexicon's protocol:

```ts
class MyController {
  async *subscribe(ctx) { yield { ... } }   // returns AsyncGenerator
  async getStatus(ctx) { return { ok: true } } // returns Promise<object>
}

router.xrpc.subscription(myLex, [MyController, 'subscribe'])  // ✓
router.xrpc.subscription(myLex, [MyController, 'getStatus'])  // ✗ Type error
//                                            ^^^^^^^^^^^
// 'getStatus' is not assignable to 'subscribe'
```

The error message includes the valid method names, so IDE autocomplete narrows to handlers compatible with the lexicon kind.

**Handler ctx is also typed against the lexicon** — `(ctx) => ...` handlers now receive a typed context (`XrpcHttpContext<L>` or `XrpcSubscriptionContext<L>`), so `ctx.input`, `ctx.params`, and `ctx.response.json(...)` infer their types from the lexicon's schemas without requiring annotations.

**Migration note:** existing code that passed handlers with mismatched shapes (e.g. an async generator on a query) will now produce type errors. These were always runtime bugs; the type system now catches them at registration. If you have intentional casts (`as any` etc.) hiding the protocol, expect to see them surface as type errors and need adjustment.

**Note on the controller method-name slot:** validation matches AdonisJS's `GetControllerHandlers<Controller>` pattern but extends it with the lexicon-kind iterability constraint. The check is structural (subscription → must return `AsyncIterable`; HTTP → must NOT return `AsyncIterable`) rather than exact-message-type matching, so lightly-typed controller methods (`async *subscribe(ctx: any)`) still validate correctly.
