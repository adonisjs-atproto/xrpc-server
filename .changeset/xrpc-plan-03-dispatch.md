---
'@thisismissem/adonisjs-atproto-xrpc': minor
---

Ship the XRPC dispatch layer:

- `XrpcServer` wraps `@atcute/xrpc-server`'s `XRPCRouter` + Node-WebSocket adapter and installs routes + the WebSocket `'upgrade'` handler.
- `createXrpcExecutor` is the single shared handler closure (closure-deduplication: one function per package instance, registered for every route). Procedure / query / subscription dispatch is selected by `lexicon.type` at request time.
- `XrpcDispatchMiddleware` (mounted at `start/kernel.ts` via the new `./middleware` subpath) intercepts `/xrpc/*` HTTP requests and hands them to atcute, with `requestContextStore` (a package-internal `AsyncLocalStorage<RequestContext>`) bridging the dispatch boundary so the executor receives the request-scoped Adonis primitives.
- The WebSocket upgrade handler uses a *snip-and-wrap* pattern: it captures the listener `@atcute/xrpc-server-node` registers and replaces it with a URL-filtering wrapper so non-XRPC upgrades (Vite HMR, app-defined WS endpoints) fall through to other listeners. This will simplify to a sibling-listener once `@atcute/xrpc-server-node` ships a release containing the URL-filter fix (commit `4c66188`).
- A minimal `XrpcProvider` installs the `router.xrpc` getter (via `Object.defineProperty(Router.prototype, ...)` — the main `Router` class isn't `Macroable` in `@adonisjs/http-server@8.x`), commits the `XrpcRouter` in `start()`, and constructs/starts the `XrpcServer` in `ready()`. Skipped in the `console` environment so ace commands don't pay the cost. `XrpcService` facade + error-reporter wiring follow in a later plan.
- New public subpath `./event-stream/framing` ships `decodeFrame` / `encodeFrame` / `DecodedFrame` (discriminated union over message / error frames) — atcute provides the CBOR primitives but no high-level decoder; this fills that gap for subscription consumers.
- New public subpath `./test_utils` ships `injectXrpcSubscription(server, lexicon, options?)` — an XRPC-aware wrapper over `light-my-websocket`'s `injectWS` that constructs `/xrpc/<nsid>` URLs, decodes atproto frames, and exposes an `AsyncIterable<DecodedFrame>` for tests to consume without binding a real port.

A future plan adds the `XrpcService` facade (registered error / subscription-error handlers), the `HttpContext.xrpc` Macroable getter, and atcute's `handleException` / `handleSubscriptionException` wiring; the executor has an explicit `ERROR-REPORTING SEAM (Plan 04)` comment-anchor where the report call splices in.
