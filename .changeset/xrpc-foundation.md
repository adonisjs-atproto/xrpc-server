---
'@thisismissem/adonisjs-atproto-xrpc': minor
---

Add foundational primitives: lexicon-type re-exports (`XrpcLexicon`, `XrpcProcedureLexicon`, `XrpcQueryLexicon`, `XrpcSubscriptionLexicon`, plus the `InferInput` / `InferOutput` / `InferParams` / `MessageOf` inference helpers); `XrpcError` hierarchy with 9 built-in subclasses; `defineConfig` with runtime DID validation; route builders (`XrpcRouter` / `XrpcRoute` / `XrpcRouteGroup`, Macroable, no auth yet); Web Fetch ↔ Adonis request/response conversion utilities; runtime context (`XrpcContext` / `XrpcResponse` / `XrpcStream`, Macroable + ALS-backed); `ExceptionHandler` base class with env-aware default sanitization; `XrpcContextFactory` for test construction; subpath exports for `./errors`, `./types`, `./factories/xrpc`, `./services/xrpc`, `./provider`.
