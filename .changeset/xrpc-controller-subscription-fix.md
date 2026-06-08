---
'@thisismissem/adonisjs-atproto-xrpc': patch
---

**Fix controller-path subscription dispatch** — registering a subscription handler via the `[Controller, 'method']` tuple form silently failed at runtime. WebSocket clients saw an immediate close with no useful data, and the server logs reported an `InternalServerError` via the `onSocketError` telemetry pipeline — making it look like an application bug rather than a routing-layer issue.

**Cause:** fold's `toHandleMethod()` always wraps the controller call in a Promise, so the executor received `Promise<AsyncIterable>` rather than `AsyncIterable`. The subscription wrapper then called `[Symbol.asyncIterator]()` on the unwrapped Promise, throwing a `TypeError`. Inline `async function*` handlers (the function form) worked because they synchronously return the generator, so this only affected the controller form.

**Fix:** the executor's internal handler invocation is now `async`, and `wrapSubscriptionIterator` awaits the resolved iterable before iterating. Both the function path and the controller path now produce the same `Promise<AsyncIterable>` shape that the wrapper handles uniformly.

No consumer code changes needed — existing controller-form subscription registrations now work as documented.
