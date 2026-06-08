---
'@thisismissem/adonisjs-atproto-xrpc': patch
---

**Typed handler context** — `ctx` in query and procedure handlers is now `XrpcHttpContext<L>`; `ctx` in subscription handlers is now `XrpcSubscriptionContext<L>`. Accessing `.response` (HTTP) or `.stream` (subscription) no longer requires a cast when the lexicon kind is known at the call site.

The `XrpcContext<L>` type alias continues to resolve to the correct concrete subclass — existing handler signatures are unchanged.

**Type narrowing helpers** — for code that holds a wide `XrpcOperationContext` reference (e.g. inside an `ExceptionHandler`):

```ts
import { isHttpContext, isSubscriptionContext } from '@thisismissem/adonisjs-atproto-xrpc'

async report(error: unknown, ctx: XrpcOperationContext | null) {
  if (ctx && isHttpContext(ctx)) {
    // ctx.response, ctx.input, ctx.params available here
  }
  if (ctx && isSubscriptionContext(ctx)) {
    // ctx.stream available here
  }
}
```

**New exports** — `XrpcOperationContext`, `XrpcHttpContext`, `XrpcSubscriptionContext`, `isHttpContext`, `isSubscriptionContext` are now exported from the package root alongside `XrpcContext`.
