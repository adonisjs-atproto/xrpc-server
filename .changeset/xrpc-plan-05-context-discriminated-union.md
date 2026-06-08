---
'@thisismissem/adonisjs-atproto-xrpc': patch
---

**Plan 05 — Context discriminated-union refactor**

Restructures `XrpcContext` as a discriminated union: a non-generic `XrpcOperationContext` abstract base + `XrpcHttpContext<L>` (query + procedure) + `XrpcSubscriptionContext<L>`.

- The public `XrpcContext<L>` symbol becomes a conditional type alias that resolves to the concrete subclass; handler signatures `(ctx: XrpcContext<typeof myLex>) => ...` work unchanged.
- `XrpcOperationContext` exposes the shared `AsyncLocalStorage` and cross-cutting fields (`request`, `signal`, `logger`, `containerResolver`, `requestId`).
- `XrpcHttpContext` adds `.lexicon`, `.params`, `.input`, `.response` (query/procedure only).
- `XrpcSubscriptionContext` adds `.lexicon`, `.params`, `.stream` (subscription only).
- Type-guard predicates `isHttpContext` / `isSubscriptionContext` exported from the package root for narrowing wide-union references.
- `XrpcContextFactory.create()` overloaded per lexicon kind; `factories/xrpc` subpath returns the concrete subclass type at the call site.
