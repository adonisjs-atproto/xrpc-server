# `@thisismissem/adonisjs-atproto-xrpc` package — design (draft, superseded)

> **Superseded by [`2026-05-19-adonisjs-atproto-xrpc-design.md`](./2026-05-19-adonisjs-atproto-xrpc-design.md).** This document is kept for traceability. The 2026-05-19 spec reifies and finalizes the architectural sketches below — refer to it for the canonical design.

**Status:** Superseded — original draft of the package design.
**Date:** 2026-05-17
**Subject:** `@thisismissem/adonisjs-atproto-xrpc` (new sibling package, not yet created)

## Summary

A generic AdonisJS package that exposes server-side XRPC routing on top of `@atcute/xrpc-server`. Provides `router.xrpc.{procedure, query, subscription}` as the consumer-facing route-declaration API, an `XrpcContext<L>` type that mirrors AdonisJS's `HttpContext`, and a server-level middleware (mounted in `start/kernel.ts`'s `server.use([...])` chain) that intercepts `^/xrpc/` requests and dispatches them through the internal `XRPCRouter`. WebSocket subscriptions dispatch at the Node-server `'upgrade'` event level (separate from HTTP middleware) but share the same router instance for handler registration. Designed to be reusable for any AdonisJS-based atproto service; `@thisismissem/adonisjs-atproto-labeler` will be the first consumer, with its existing `subscribeLabels` handler migrating onto the new framework as part of the integration.

## Context and goals

The `simple-atproto-labeler` project needs to receive incoming XRPC calls (`com.atproto.moderation.createReport` per `2026-05-17-receive-reports-and-appeals-design.md`). The existing labeler package (`@thisismissem/adonisjs-atproto-labeler`) already has a closure-based handler for `subscribeLabels` mounted on a Node-level `XRPCRouter` (constructed inline in the provider's `ready()` hook in `providers/provider.ts`). Adding a second handler — and especially a _consumer-defined_ handler that needs container-resolved services — exposes the limits of the current ad-hoc shape.

The decision is to **extract the XRPC-bridge capability into its own package** rather than bolting it onto the labeler package. Two reasons:

1. The bridge is genuinely orthogonal to labeler concerns. Any future AdonisJS-based atproto service — an OAuth provider, a PDS, a moderation-tooling backend, an AppView — will need the same router-extension mechanism.
2. The labeler package's API should describe _labeler_ concerns (DID, signing key, label store). Conflating it with framework concerns blurs the boundary.

Goals:

- Be the canonical "XRPC handlers as AdonisJS controllers" bridge.
- Surface the existing `@atcute/xrpc-server` API through AdonisJS-idiomatic patterns: router macros / getters, controllers via `#generated/controllers`, server-level middleware in `start/kernel.ts`.
- Stay free of atproto-domain-specific logic. The package knows about XRPC routing and dispatch; consumers bring their own lexicons.
- Provide the migration path for the labeler package's existing `subscribeLabels` handler — same shape from the outside, but expressed through the new framework primitives internally.

## Out of scope

- **Specific atproto lexicons.** Lexicon spec objects come from `@atcute/atproto` / `@atcute/bluesky` / equivalents at the consumer side. This package doesn't depend on them.
- **Atproto-specific helpers.** Label signing, the label store, ace commands like `generate:signing-key` — all stay in the labeler package or future atproto packages.
- **Client-side XRPC.** This package is server-side dispatch only. `@atcute/client` is the canonical client library.
- **Caching, persistence, idempotency keys.** Purely the routing/dispatch layer.
- **CORS implementation.** Inherits Adonis's CORS middleware via positioning in the `server.use([...])` chain.

## Architecture

When creating new packages, we always use an existing package's code as a base, but wipe out the git status and pending changesets, as we need all the trusted publishing setup (actions + changesets).

### Package layout (proposed)

```
@thisismissem/adonisjs-atproto-xrpc/
├── index.ts                — entrypoint; re-exports public API + defineConfig
├── configure.ts            — Adonis configure stub (registers provider, copies config stub)
├── providers/
│   └── xrpc_provider.ts    — registers router getter, container bindings, ready() hooks
├── services/
│   └── router.ts           — singleton accessor for the XRPCRouter
├── src/
│   ├── builder.ts          — XrpcRouterBuilder class (the router.xrpc surface)
│   ├── context.ts          — XrpcContext class
│   ├── middleware/
│   │   ├── dispatch.ts     — server-level middleware that intercepts /xrpc/*
│   │   └── service_jwt.ts  — ServiceJwtVerifier-wrapping middleware
│   ├── errors.ts           — Adonis-exception ↔ XRPC-error mapping
│   └── types.ts            — XrpcLexicon, InferInput, InferParams, etc.
├── stubs/
│   └── config/
│       └── atproto_xrpc.stub  — stub for consumer config/atproto_xrpc.ts
└── package.json
```

### Public exports

From `index.ts`:

```ts
export { defineConfig } from './src/define_config.js'
export { configure } from './configure.js'
export type { XrpcContext } from './src/context.js'
export type { XrpcConfig, XrpcRouterBuilder, XrpcLexicon } from './src/types.js'
export { XrpcError, AuthRequiredError, ForbiddenError, InvalidRequestError } from './src/errors.js'
```

From the `/middleware` subpath:

```ts
// @thisismissem/adonisjs-atproto-xrpc/middleware — for import in start/kernel.ts
export { default } from './src/middleware/dispatch.js'
```

From the `/services/router` subpath:

```ts
// @thisismissem/adonisjs-atproto-xrpc/services/router — for advanced container-level use
export { default } from './services/router.js'
```

### Router getter: `router.xrpc`

The package's provider, during `register()`, calls `router.getter('xrpc', ...)` (AdonisJS's Macroable mechanism) to attach an `xrpc` property:

```ts
// in xrpc_provider.ts
import router from '@adonisjs/core/services/router'

router.getter('xrpc', function () {
  return new XrpcRouterBuilder(this.app)
})
```

Plus TypeScript module augmentation in `src/types.ts`:

```ts
declare module '@adonisjs/core/http' {
  interface Router {
    xrpc: XrpcRouterBuilder
  }
}
```

`XrpcRouterBuilder` exposes the typed declaration API:

```ts
class XrpcRouterBuilder {
  constructor(private app: ApplicationService) {}

  procedure<L extends XrpcProcedureLexicon>(
    lexicon: L,
    handler: [Controller, MethodOf<Controller, XrpcContext<L>>]
  ): void

  query<L extends XrpcQueryLexicon>(
    lexicon: L,
    handler: [Controller, MethodOf<Controller, XrpcContext<L>>]
  ): void

  subscription<L extends XrpcSubscriptionLexicon>(
    lexicon: L,
    handler: [Controller, MethodOf<Controller, XrpcContext<L>>]
  ): void
}
```

Internally, each method registers a handler on the package's singleton `XRPCRouter` (from `@atcute/xrpc-server`) via `router.addProcedure / addQuery / addSubscription`. The registered handler is a closure that:

1. Constructs an `XrpcContext` for the incoming request.
2. Resolves the controller class via `this.app.container.make(Controller)`.
3. Calls `instance[methodName](xrpcCtx)` and returns the result wrapped in the appropriate XRPC response (`json(...)` for procedure/query results, async-iterable for subscriptions).

### Dispatch: server-level middleware

```ts
// start/kernel.ts (consumer)
server.use([
  () => import('@adonisjs/cors/cors_middleware'),
  () => import('@thisismissem/adonisjs-atproto-xrpc/middleware'),
  () => import('@adonisjs/static/static_middleware'),
  () => import('@adonisjs/vite/vite_middleware'),
  () => import('@adonisjs/inertia/inertia_middleware'),
])
```

Middleware implementation (sketch):

```ts
export default class XrpcDispatchMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (!ctx.request.url().startsWith('/xrpc/')) {
      return next()
    }

    const router = await ctx.containerResolver.make(XRPC_ROUTER_BINDING)
    const webRequest = adonisRequestToWebRequest(ctx.request)
    const webResponse = await router.fetch(webRequest)
    return webResponseToAdonisResponse(webResponse, ctx.response)
  }
}
```

The middleware short-circuits the rest of the Adonis pipeline on a match. Non-matching requests pass through normally.

**Adonis-request ↔ Web-request bridging.** Adonis's HTTP layer uses Node's `IncomingMessage` / `ServerResponse`; `@atcute/xrpc-server` works with the Web Fetch API's `Request` / `Response`. The bridge functions construct a `Request` from the Adonis `Request` (URL, method, headers, body stream) and write the resulting `Response` back to the Adonis `Response`. This is a small but non-trivial piece — likely lifted from `@remix-run/node-fetch-server` or equivalent.

### Dispatch: WebSocket upgrade

WebSocket connections don't traverse HTTP middleware — they're handled by the Node server's `'upgrade'` event. The package's provider `ready()` hook installs a handler analogous to today's labeler-package setup:

```ts
// in xrpc_provider.ts, ready()
async ready() {
  if (this.app.getEnvironment() !== 'web') return

  const appServer = await this.app.container.make('server')
  const server = appServer.getNodeServer()
  if (!server) return

  const ws = createNodeWebSocket()
  ws.injectWebSocket(server, this.xrpcRouter)
}
```

`createNodeWebSocket` from `@atcute/xrpc-server-node` does the upgrade-event listening + protocol negotiation. The same `XRPCRouter` instance is used for both HTTP dispatch (via middleware) and subscription dispatch (via `injectWebSocket`); the transport-level interception differs but the handler registry is unified.

### `XrpcContext` shape (mirrors `HttpContext`)

```ts
class XrpcContext<L extends XrpcLexicon> {
  // HttpContext-mirrored properties:
  request: Request // Web Request (XRPC speaks Web fetch)
  response: XrpcResponseHelper // json(), error(), redirect(), etc.
  logger: Logger // request-scoped, matches HttpContext
  containerResolver: ContainerResolver // DI access; matches HttpContext convention
  requestId: string // request correlation ID; matches HttpContext

  // XRPC-specific properties:
  input: InferInput<L> // typed body input for procedures
  params: InferParams<L> // typed query parameters for queries
  jwt?: VerifiedJwt // populated when service-JWT middleware ran
  lexicon: L // the lexicon spec object (handler self-reference)
}
```

Property names match `HttpContext` where the concepts overlap (`request`, `response`, `logger`, `containerResolver`, `requestId`). XRPC-specific additions are `input`, `params`, `jwt`, `lexicon`. The class is generic over the lexicon `L` so `input` and `params` are statically typed from the lexicon's schema.

### Service-JWT verification middleware

For endpoints that require service-to-service authentication (the common case for atproto labelers / Ozone / etc.), the package provides a middleware factory that wraps `ServiceJwtVerifier` from `@atcute/xrpc-server/auth`:

```ts
// usage in start/kernel.ts or per-route configuration
serviceJwt({
  serviceDid: 'did:web:labeler.example.com', // the audience
  resolver: { plc: true, web: true }, // DID document resolvers
})
```

Returns a middleware closure that:

1. Extracts the `Authorization: Bearer <jwt>` header.
2. Verifies signature, audience, `lxm`, expiration via the `@atcute/xrpc-server/auth` primitives.
3. Populates `XrpcContext.jwt` with the verified payload (issuer DID, etc.) on success.
4. Throws `AuthRequiredError` on failure (mapped to a 401 XRPC error response).

**Open question:** How does the consumer attach this middleware to specific routes? Three sketches:

- **Per-route via builder method chaining**: `router.xrpc.procedure(lexicon, [Controller, method]).use(serviceJwt(...))`. Adonis-idiomatic.
- **Per-lexicon via lexicon's `auth` field**: read the lexicon's `auth` declaration and apply matching middleware automatically. Convention-over-configuration; less explicit.
- **Globally via middleware ordering**: `serviceJwt` middleware sits in `server.use([...])` chain before the XRPC dispatch middleware; populates context for everything. Wrong for endpoints that don't require auth.

The first approach is most Adonis-idiomatic; the third is wrong (forces auth on everything). The second is interesting but couples the package more tightly to specific lexicon conventions. Likely answer: first.

### Error mapping

XRPC error responses follow the atproto convention: JSON body `{ error: string, message?: string }` with appropriate HTTP status codes. The package provides:

- `XrpcError` base class (extends `@poppinss/exception`-style).
- `AuthRequiredError` (401), `ForbiddenError` (403), `InvalidRequestError` (400), `RateLimitExceededError` (429), `InternalServerError` (500), `UpstreamFailureError` (502), `NotEnoughResourcesError` (503), `UpstreamTimeoutError` (504) — matching `@atcute/xrpc-server`'s convenience subclasses.
- An error handler at the middleware level that catches these and serializes to the wire format. Other exceptions get mapped to `InternalServerError` with the description suppressed in production.

## Configuration

```ts
// consumer: config/atproto_xrpc.ts
import { defineConfig } from '@thisismissem/adonisjs-atproto-xrpc'
import env from '#start/env'

export default defineConfig({
  // Service DID — the audience for incoming JWT verification.
  // Read from env for did:web typically.
  serviceDid: env.get('ATPROTO_SERVICE_DID'),

  // DID document resolvers used for JWT issuer verification.
  // Defaults to both plc and web; consumer can narrow if needed.
  didResolvers: {
    plc: true,
    web: true,
  },
})
```

The provider reads this config during `register()` and uses it to construct the `ServiceJwtVerifier` instance, which the service-JWT middleware factory shares.

## Migration: existing `subscribeLabels` handler

The labeler package currently constructs an `XRPCRouter` inline in its provider `ready()` hook and registers `subscribeLabels` as a closure on it. With the new package in place, the labeler package:

1. Depends on `@thisismissem/adonisjs-atproto-xrpc` (peer dependency, since the consumer instantiates the framework).
2. Drops its own `XRPCRouter` construction; uses the singleton from the xrpc package via container binding.
3. Moves the `subscribeLabels` handler into a package-internal controller (e.g., `src/controllers/labels_xrpc_controller.ts` within the labeler package).
4. Registers the handler via `router.xrpc.subscription(...)` — but from within the labeler package's own provider boot (since the labeler package owns this handler, not the consumer).

**Open question:** Can the labeler package's provider safely call `router.xrpc.subscription(...)` during _its_ boot, given that `router.xrpc` is installed by the xrpc package's provider? Provider boot ordering: the xrpc package must register its router getter before the labeler package's provider runs. AdonisJS provider ordering can be declared via the `aliases` field or controlled by registration order in `adonisrc.ts`. Worth verifying during implementation.

Alternative: the labeler package could call `xrpcRouter.addSubscription(...)` directly on the container-bound router instance, bypassing the macro-based interface. Less ergonomic but avoids the provider-ordering coupling. Decide during implementation.

## Open decisions

These need calls before or during implementation:

### Package name and namespacing

`@thisismissem/adonisjs-atproto-xrpc` is the proposed name. Alternatives:

- `@thisismissem/adonisjs-xrpc` — drop the "atproto" since XRPC is the abstract protocol. But XRPC effectively exists for atproto; the naming honesty cuts the other direction.
- `@thisismissem/adonisjs-atproto-server` — broader name suggesting "AdonisJS-based atproto services" as a umbrella. Risks scope creep.

Sticking with `@thisismissem/adonisjs-atproto-xrpc` as the working name.

### Per-route auth middleware attachment

Three options sketched above; first (chained `.use()` call after `router.xrpc.procedure(...)`) is the leading candidate. Needs confirmation when implementing.

### Provider boot ordering for the labeler refactor

The labeler package's provider needs `router.xrpc` available at its own boot — meaning the xrpc package's provider must run first. Verify the ordering mechanism (Adonis provider aliases / explicit registration order in `adonisrc.ts`).

### Exposed surface area

How much of `@atcute/xrpc-server`'s API do we re-expose vs. wrap?

- Definitely exposed: lexicon types, error classes (matched by name/structure).
- Definitely wrapped: the `XRPCRouter` itself (consumer uses `router.xrpc`, not the raw atcute router).
- Open: middleware composition primitives, the `json()` helper, etc.

Tilt toward wrapping for the consumer-facing API; leave raw atcute primitives available for advanced cases via container binding.

### CORS configuration interaction

`@adonisjs/cors` runs before this package's dispatch middleware in the `server.use([...])` chain, so XRPC requests inherit Adonis's CORS configuration. But XRPC clients (Bluesky web app, etc.) may need specific origins / methods / headers different from the rest of the application. Two approaches:

- **Same CORS config for everything.** Consumer-side responsibility; configure CORS to be permissive enough for both XRPC and regular HTTP.
- **Package-provided CORS middleware specifically for /xrpc/\* requests.** More targeted but doubles up the CORS layer.

Likely first option — keep this package narrow. Document the CORS interaction in the readme.

### Subscription / WebSocket testing approach

Testing the WS upgrade path is fiddly. Functional tests need to start a real HTTP server, perform a WS upgrade, exchange CBOR frames. The labeler package's existing tests (per the project memory: "Functional tests use real HTTP, not request injection") have a precedent; reuse the pattern.

### How the labeler package's `subscribeLabels` handler exposes its dependency on the labeler config

When `subscribeLabels` moves into a controller within the labeler package, it needs access to the `labeler` service (the `@atcute/labeler`-instance container binding). Constructor injection via `@inject()` against the labeler-package's container-bound `Labeler` service — the package already exposes this. Verify the wiring during implementation.

## Implementation notes

### TypeScript inference for handlers

The signature `procedure<L>(lexicon: L, handler: [Controller, MethodOf<Controller, XrpcContext<L>>])` relies on TypeScript inferring `L` from the lexicon argument and then requiring the controller method to accept exactly `XrpcContext<L>`. This is the same shape `@atcute/xrpc-server` uses internally (`router.addProcedure(L, { handler })`); we're just routing through a controller reference instead of inline.

`MethodOf<Controller, Arg>` is a conditional type that extracts method names from `Controller` whose signature accepts `Arg`. Tooling for this kind of conditional type extraction is well-trodden TypeScript (Adonis's own router types do similar work).

### Test setup

The package's own Japa test suite uses the `adonisjs-respond-with` pattern (per memory: "AdonisJS package test bootstrap pattern" — `IgnitorFactory` + `TestUtilsFactory` helper). Tests:

- **Unit**: `XrpcRouterBuilder` registration; error mapping; JWT verifier wrapping.
- **Functional**: real HTTP server boot, register a test procedure, hit it from a client, assert response shape. Same approach the labeler package already uses for `subscribeLabels`.
- **Type-level**: `expectTypeOf` (or equivalent) tests that the typed `input` / `params` flow correctly through the builder signature.

## Future work

Items the package might grow into post-v1:

- **Rate-limit middleware integration** — `@adonisjs/limiter` interop, per-route limits via the chained `.use()` syntax.
- **OAuth-flow middleware** — for endpoints that require user-OAuth-style auth (as opposed to service JWTs). When atproto OAuth lands in `@atcute/*`, this package could provide the AdonisJS bridge.
- **Lexicon-driven `extra` validation** — beyond the body-shape validation `@atcute/xrpc-server` already does, surface helpful errors for common mistakes (e.g., missing optional fields the lexicon flags).
- **Service-JWT minting helpers** — for outbound XRPC calls (the labeler making authenticated calls to other services). Currently a consumer concern via `createServiceJwt` from `@atcute/xrpc-server/auth`; could be wrapped.
- **Catch-all dispatcher diagnostics** — an ace command that lists registered XRPC endpoints (`node ace xrpc:list`), useful for debugging.

## Related work

- `docs/superpowers/specs/2026-05-17-receive-reports-and-appeals-design.md` — the first consumer of this package.
- `docs/superpowers/specs/2026-05-01-lucid-label-store-design.md` — the labeler package's previous spec; precedent for the package-extraction + yalc workflow.
- `@thisismissem/adonisjs-atproto-labeler` — the existing labeler package that will refactor to consume this one.
- `@atcute/xrpc-server` — the underlying XRPC routing library this package wraps.
- `@atcute/xrpc-server-node` — the Node-specific WebSocket adapter.
- `@atcute/xrpc-server/auth` — service-JWT verification primitives.
