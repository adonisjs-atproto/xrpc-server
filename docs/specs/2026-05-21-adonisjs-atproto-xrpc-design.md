# `@thisismissem/adonisjs-atproto-xrpc` package — design

**Status:** Final — supersedes `2026-05-19-adonisjs-atproto-xrpc-design.md`.
**Date:** 2026-05-21
**Subject:** `@thisismissem/adonisjs-atproto-xrpc` (now in its own repository; scaffolding exists, implementation pending)

**Changes from 2026-05-19**: the auth declaration surface is reshaped, and the v1 scope is narrowed to service-JWT auth only.

- **Service grouping**: `router.xrpc.group(callback)` provides general-purpose route grouping (mirroring Adonis's `router.group()`), with a `.serviceAuth(options?)` method on the group handle and on per-route builders. The previous spec collapsed authentication to service-JWT-via-`router.xrpc.authenticated(...)` wrappers; the grouping + per-route-chainable split replaces it.
- **OAuth deferred to a future minor**: server-side AT Protocol OAuth verification isn't a solved problem in the ecosystem yet — atproto OAuth tokens are opaque, so verification requires introspection (or similar), and the reference implementations (`@atproto/bsky`, `@atproto/ozone`) handle auth via service JWT plus a Bluesky-specific entryway-session-token stopgap. Neither implements OAuth verification. The 2026-05-21 draft's `.auth('oauth' | 'service', options?)` surface is therefore narrowed to `.serviceAuth(options?)` in v1; an OAuth-mode sibling method ships when the ecosystem-level pattern lands. See _Future work_.
- **Type shape**: `XrpcAuth` is a discriminated-union resolver (single-arm in v1: `{ kind: 'service'; ... }`); the discriminator stays even though there's only one inhabitant so that adding the future `'oauth'` arm is a non-breaking type expansion. The previous `getUserOrFail` / `getJwtOrFail` vocabulary conflated user and service identity and is gone.
- **`mary-ext/atcute#76` reframing**: it's one of _two_ upstream gates (the other being protocol-level — the Lexicon spec needs to distinguish OAuth from service JWT before atcute can expose it), and the OAuth-verifier story is a third independent gate.

## Summary

An AdonisJS v7+ package that bridges AdonisJS's HTTP/router conventions to AT Protocol XRPC server-side dispatch, wrapping [`@atcute/xrpc-server`](https://www.npmjs.com/package/@atcute/xrpc-server) and its Node WebSocket adapter (`@atcute/xrpc-server-node`).

The consumer-facing surface is `router.xrpc.{procedure, query, subscription}` for declaring routes, with `router.xrpc.group(callback)` for general-purpose route grouping (mirroring Adonis's `router.group()`) and a chainable `.serviceAuth(options?)` declaration on each route builder (and on group builders). Each handler receives an `XrpcContext<L>` typed against the registered lexicon. HTTP-side dispatch runs as server-level middleware mounted in `start/kernel.ts`'s `server.use([...])` chain; WebSocket subscription dispatch hooks the Node server's `'upgrade'` event via the atcute adapter, with both paths sharing a single registered `XRPCRouter` instance.

The package is the framework half of the equation. Consumers bring their own lexicons (canonical Lexicon JSON, codegen'd through `@atcute/lex-cli` for the package's consumption) and their own handler implementations. `@thisismissem/adonisjs-atproto-labeler` will be the first consumer; its existing closure-based `subscribeLabels` handler migrates onto the new framework as part of the integration.

## Context and goals

The `simple-atproto-labeler` project needs to receive incoming XRPC calls (`com.atproto.moderation.createReport`) and continue serving the existing `subscribeLabels` subscription. The labeler package (`@thisismissem/adonisjs-atproto-labeler`) additionally wants to register a `com.atproto.label.queryLabels` handler — a query that returns the current label set, complementing the existing subscription. The existing labeler package had a closure-based handler for `subscribeLabels` mounted on a Node-level `XRPCRouter` constructed inline in the provider's `ready()` hook. Adding more handlers — especially _consumer-defined_ ones that need container-resolved services — exposed the limits of that ad-hoc shape.

The decision is to extract the XRPC-bridge capability into its own package rather than bolting it onto the labeler. Two reasons:

1. The bridge is genuinely orthogonal to labeler concerns. Any future AdonisJS-based atproto service — an OAuth provider, a PDS, a moderation-tooling backend, an AppView — will need the same router-extension mechanism.
2. The labeler package's API should describe _labeler_ concerns (DID, signing key, label store). Conflating it with framework concerns blurs the boundary.

Goals:

- Be the canonical "XRPC handlers as AdonisJS controllers" bridge.
- Surface `@atcute/xrpc-server`'s API through AdonisJS-idiomatic patterns: router macros / getters, controllers via `#generated/controllers`, server-level middleware in `start/kernel.ts`.
- Stay free of atproto-domain-specific logic. The package knows about XRPC routing and dispatch; consumers bring their own lexicons.
- Integrate with AdonisJS's existing DI / logging / error-handling infrastructure rather than parallel mechanisms.
- Provide the migration path for the labeler package's existing `subscribeLabels` handler — same shape from the outside, but expressed through the new framework primitives internally.

## Ecosystem decision

The AT Protocol TypeScript ecosystem currently has two parallel surfaces:

- **Bluesky-official**: `@atproto/lex` (new unified package replacing `@atproto/api` + `@atproto/lexicon` + `@atproto/xrpc` + `@atproto/lex-cli`); pairs with `@atproto/xrpc-server` for server-side dispatch.
- **`@atcute/*` (mary-ext community)**: `@atcute/client`, `@atcute/lexicons`, `@atcute/lex-cli`, `@atcute/xrpc-server`, `@atcute/xrpc-server-node`.

The two are not interoperable at the lexicon-object level: each generates and consumes its own runtime representation of lexicons. The wire format is identical (both serialize/deserialize the same atproto JSON/CBOR), but the typed runtime objects passed to server registration APIs differ.

`@atproto/xrpc-server` (Bluesky-official) requires Express 4 plus heavy supporting packages (`http-errors`, `rate-limiter-flexible`, `mime-types`). Pulling Express into an AdonisJS app would create three competing HTTP abstractions (Node http, Express, AdonisJS). `@atcute/xrpc-server` speaks the Fetch API (`Request` / `Response`) and ships a small dep set — composes cleanly with any Node-http-based framework.

**This package targets `@atcute/xrpc-server`** as its underlying server library.

Consumers using `@atproto/lex` elsewhere in their codebase (e.g., for outbound XRPC client calls via `Client`) can keep that — the lexicon JSON source is shared, and they generate both sets of typed lexicons from one canonical `lexicons/src/**/*.json` source tree:

- `@atcute/lex-cli` → @atcute-typed metadata used by this package for server registration
- `@atproto/lex build` → @atproto/lex-typed objects used for outbound `Client` calls

The dual-codegen step lives in the consumer's `lexicons/` package, not in this XRPC bridge. The bridge stays narrow.

## Out of scope

- **Consumer integration work.** The labeler-package migration of `subscribeLabels`, the addition of the `queryLabels` handler in the labeler package, and the `createReport` handler in `simple-atproto-labeler` all happen in their respective repositories as separate work, after this package ships. The migration example in this spec is illustrative of consumer use, not a work item for this package.
- **Specific atproto lexicons.** Lexicon spec objects come from `@atcute/atproto` / `@atcute/bluesky` / consumer-published packages. This package doesn't depend on them.
- **Atproto-specific helpers.** Label signing, the label store, ace commands like `generate:signing-key` — all stay in the labeler package or future atproto packages.
- **Client-side XRPC.** This package is server-side dispatch only. `@atcute/client` is the canonical client library; `@atproto/lex` `Client` is the alternative for consumers in that ecosystem.
- **Caching, persistence, idempotency keys.** Purely the routing/dispatch layer.
- **CORS implementation.** Inherits AdonisJS's CORS middleware via positioning in the `server.use([...])` chain.

## v1 surface

All three XRPC method types ship in v1: `procedure` (HTTP POST), `query` (HTTP GET), and `subscription` (WebSocket). The three share most of their machinery in `@atcute/xrpc-server` (handler closure, controller resolution, error mapping); the marginal cost of including all three is low.

The initial consumer needs span all three method types and motivate v1's scope, but those handler migrations and additions are _not_ part of this package's implementation — they happen in their respective consumer repositories once this package ships:

- Migrate the labeler's existing `subscribeLabels` handler (subscription) — happens in `adonisjs-atproto-labeler`
- Add a `queryLabels` handler in the labeler package (query) — happens in `adonisjs-atproto-labeler`
- Add a `createReport` handler for the receive-reports work (procedure) — happens in `simple-atproto-labeler`

This package's implementation only delivers the framework primitives those consumers will use.

## Prerequisites

Consumers must set `useAsyncLocalStorage: true` in `config/app.ts`. This enables AdonisJS's per-request `HttpContext` ALS, which the package relies on for the HTTP-triggered XRPC dispatch path — the registered handler closures (running inside `@atcute/xrpc-server`'s router internals) access the triggering `HttpContext` via `HttpContext.getOrFail()`, which requires the ALS to be active.

Without this flag, HTTP-triggered XRPC requests would have no reliable way to access the request-scoped HttpContext (logger, containerResolver, response state) from inside the handler closure, since atcute's router doesn't expose Adonis-specific context. The flag is opt-in for plain Adonis apps, but mandatory for this package.

Subscriptions don't depend on the flag — they use the package's own `httpContextStore: AsyncLocalStorage<HttpContext>` populated at the Node `'upgrade'` event from the synthetic HttpContext built from the upgrade `IncomingMessage`.

The package's `configure` ace command verifies this flag is set during install; if it isn't, the command prompts the consumer to enable it (or adds it automatically with confirmation).

## Architecture

### Package layout

```
@thisismissem/adonisjs-atproto-xrpc/
├── index.ts                — entrypoint; re-exports public API + defineConfig + error classes
├── configure.ts            — Adonis configure stub (registers provider, copies config stub)
├── providers/
│   └── xrpc_provider.ts    — registers router getter, container bindings, ready() hooks
├── services/
│   ├── xrpc.ts             — service singleton (analog to @adonisjs/core/services/server); exposes errorHandler() + routes accessor
│   └── router.ts           — singleton accessor for the XRPCRouter
├── hooks/
│   └── index_xrpc.ts            — codegen hook for hooks.init (v1 phase 2)
├── commands/
│   ├── list_xrpc_routes.ts     — `list:xrpc:routes` ace command (lists registered XRPC endpoints)
│   └── make_xrpc_controller.ts — `make:xrpc:controller` ace command (scaffolds XRPC controllers)
├── factories/
│   └── http.ts            — XrpcContextFactory (test-facing; parallels @adonisjs/core/factories/http)
├── src/
│   ├── define_config.ts    — defineConfig + XrpcConfig typing
│   ├── builder.ts          — XrpcRouter class (the router.xrpc surface)
│   ├── context.ts          — XrpcContext + XrpcAuth + XrpcStream + XrpcResponse
│   ├── serializer.ts       — XrpcSerializer extending @adonisjs/http-transformers BaseSerializer
│   ├── http_context.ts     — Macroable getter (HttpContext.xrpc) + ALS for subscription path
│   ├── exception_handler.ts — XrpcException service that holds the resolved handler factory
│   ├── middleware/
│   │   └── dispatch.ts     — server-level middleware that intercepts /xrpc/*
│   ├── errors.ts           — XrpcError + built-in subclasses (extends @poppinss/exception)
│   └── types.ts            — XrpcLexicon, InferInput, InferParams, InferOutput, XrpcMessage
├── stubs/
│   └── config/
│       └── atproto_xrpc.stub  — stub for consumer config/atproto_xrpc.ts
└── package.json
```

The published artifact (`build/`) is produced by tsdown for ESM JS plus tsc for declaration emission, with stubs copied verbatim — matching the current scaffolding. Subpath exports are declared explicitly in `package.json#exports`.

### Public exports

From `index.ts`:

```ts
export { defineConfig } from './src/define_config.js'
export { configure } from './configure.js'
export type { XrpcContext } from './src/context.js'
export type {
  XrpcConfig,
  XrpcRouter,
  XrpcLexicon,
  InferInput,
  InferParams,
  InferOutput,
  XrpcMessage,
} from './src/types.js'
export type { XrpcAuthResult, AuthMode } from './src/context.js'
export { isService } from './services/xrpc.js' // re-exported from services/xrpc

// Re-exported from `@atcute/xrpc-server/auth` so consumers can mint service JWTs in
// tests without adding atcute as a direct dep. Outbound minting in real consumer code
// goes through `@atcute/client` (which handles service-JWT minting for outbound calls
// internally); the direct `createServiceJwt` import is primarily a test-side affordance.
export { createServiceJwt } from '@atcute/xrpc-server/auth'
export {
  XrpcError,
  AuthRequiredError,
  ForbiddenError,
  InvalidRequestError,
  RateLimitExceededError,
  InternalServerError,
  UpstreamFailureError,
  NotEnoughResourcesError,
  UpstreamTimeoutError,
} from './src/errors.js'
```

Subpath exports:

```ts
// @thisismissem/adonisjs-atproto-xrpc/middleware — for import in start/kernel.ts
export { default } from './src/middleware/dispatch.js'

// @thisismissem/adonisjs-atproto-xrpc/services/xrpc — for kernel.ts registration
export { default } from './services/xrpc.js'

// @thisismissem/adonisjs-atproto-xrpc/services/router — for advanced container-level use
export { default } from './services/router.js'

// @thisismissem/adonisjs-atproto-xrpc/hooks — for adonisrc.ts hooks.init (v1 phase 2)
export { indexXrpc } from './hooks/index_xrpc.js'

// @thisismissem/adonisjs-atproto-xrpc/factories/http — for test setup
export { XrpcContextFactory } from './factories/http.js'
```

### Router getter: `router.xrpc`

The package's provider, during `register()`, calls `router.getter('xrpc', ...)` (AdonisJS's Macroable mechanism) to attach an `xrpc` property:

```ts
// in xrpc_provider.ts
import router from '@adonisjs/core/services/router'

router.getter('xrpc', function () {
  return new XrpcRouter(this.app)
})
```

Plus TypeScript module augmentation in `src/types.ts`:

```ts
declare module '@adonisjs/core/http' {
  interface Router {
    xrpc: XrpcRouter
  }
}
```

`XrpcRouter` exposes the typed declaration API. The handler shapes mirror Adonis's own router types (`get` / `post` / etc.) — accepting either an inline function or a `[Controller | LazyImport<Controller>, methodName?]` tuple, with a `GetXrpcControllerHandlers` helper that narrows method names to those accepting `XrpcContext<L>` as the first parameter:

```ts
import type { Constructor, LazyImport } from '@poppinss/utils/types'

// Inline-handler function shapes:
type XrpcRouteFn<L> = (ctx: XrpcContext<L>) => XrpcHandlerReturn<L>
type XrpcSubscriptionFn<L> = (ctx: XrpcContext<L>) => AsyncIterable<XrpcMessage<L>>

// Narrows a controller's method names to those whose first parameter is XrpcContext<L>:
type GetXrpcControllerHandlers<Controller extends Constructor<any>, L> = {
  [K in keyof InstanceType<Controller>]: InstanceType<Controller>[K] extends (
    ctx: XrpcContext<L>,
    ...args: any[]
  ) => any
    ? K
    : never
}[keyof InstanceType<Controller>]

// In v1, only service-JWT auth ships. AuthMode is a derived type so adding the
// future `'oauth'` arm to XrpcAuthResult automatically widens AuthMode without
// touching consumers.
type AuthMode = XrpcAuthResult['kind'] // = 'service' in v1

type ServiceAuthOptions = { optional?: boolean }

// `XrpcRouter`, `XrpcRoute`, and `XrpcRouteGroup` all extend `Macroable` (from
// `@poppinss/macroable`) so plugin packages can attach declarative methods at runtime —
// e.g., a future `@adonisjs/limiter` integration can register `.rateLimit(...)` via
// `XrpcRoute.macro('rateLimit', fn)` from its provider's register() phase without this
// package shipping the dependency directly. Mirrors Adonis's own Router / Route / RouteGroup
// pattern exactly. Consumers add module-augmentation typings:
//
//   declare module '@thisismissem/adonisjs-atproto-xrpc' {
//     interface XrpcRoute { rateLimit(opts: ...): this }
//   }
//
// Constructors are marked @internal — only `XrpcRouter` constructs `XrpcRoute` and
// `XrpcRouteGroup` instances. Consumers receive them as return values from `procedure` /
// `query` / `subscription` / `group` calls, but never `new` them directly.

class XrpcRoute extends Macroable {
  /** @internal */
  constructor(private decl: RouteAuthDecl) {
    super()
  }
  serviceAuth(options?: ServiceAuthOptions): this
}

class XrpcRouteGroup extends Macroable {
  /** @internal */
  constructor(
    private groupDecl: RouteAuthDecl,
    private routes: XrpcRoute[]
  ) {
    super()
  }
  serviceAuth(options?: ServiceAuthOptions): this
}

class XrpcRouter extends Macroable {
  constructor(private app: ApplicationService) {
    super()
  }

  procedure<L extends XrpcProcedureLexicon, T extends Constructor<any>>(
    lexicon: L,
    handler: XrpcRouteFn<L> | [LazyImport<T> | T, GetXrpcControllerHandlers<T, L>?]
  ): XrpcRoute

  query<L extends XrpcQueryLexicon, T extends Constructor<any>>(
    lexicon: L,
    handler: XrpcRouteFn<L> | [LazyImport<T> | T, GetXrpcControllerHandlers<T, L>?]
  ): XrpcRoute

  subscription<L extends XrpcSubscriptionLexicon, T extends Constructor<any>>(
    lexicon: L,
    handler: XrpcSubscriptionFn<L> | [LazyImport<T> | T, GetXrpcControllerHandlers<T, L>?]
  ): XrpcRoute

  // General-purpose route grouping (mirrors Adonis's router.group()). Returns an
  // `XrpcRouteGroup` exposing `.serviceAuth(...)` to apply service-JWT auth to every
  // route declared inside the callback. v1 exposes only `.serviceAuth()`; `.prefix()`
  // and `.middleware()` are not implemented (XRPC paths are fixed at /xrpc/<NSID>;
  // middleware is YAGNI until a consumer needs it).
  group(callback: () => void): XrpcRouteGroup
}
```

The `LazyImport<T>` shape (`() => Promise<{ default: T }>`) lets consumers defer controller loading until first use — same pattern Adonis's router supports for `[() => import('#controllers/foo'), 'index']`. This isn't only an ergonomic choice for boot-time deferral: it's also what enables **hot reloading** of controller code in development. Adonis's HMR system invalidates the LazyImport callback's resolved module when the underlying controller file changes, so the next XRPC request re-imports the fresh module. Eager class references (e.g., `[ReportsController, 'create']` where `ReportsController` is imported at the top of `routes.ts`) bypass HMR — the route holds a permanent reference to the originally-imported class. Consumers should prefer the `LazyImport` form for any controller they want to iterate on without restarting the dev server.

The optional second tuple element (the method name) is type-narrowed by `GetXrpcControllerHandlers<T, L>` so consumers get autocomplete + compile-time errors when naming a method that doesn't accept the right `XrpcContext<L>` shape. If omitted, the package falls back to a convention (likely `handle`, matching Adonis's default).

Registration is **closure-deduplicated**: rather than create N wrapper closures (one per registered route, each capturing `lexicon` / `handler` / `auth` in its lexical scope), the package maintains a shared `RouteRegistry` (`Map<string, RouteInfo>` indexed by NSID) and registers a single shared **executor function** with atcute for every route. This matters at scale: a service hosting `com.atproto.*` + `app.bsky.*` lexicons easily reaches 100-200+ registered handlers (verified: `com.atproto.*` ships 86 XRPC methods in `@atcute/atproto`; `app.bsky.*` has 71+ in published Bluesky lexicons), and per-route closures would each retain references to their full captured scope — meaningful memory pressure that scales linearly.

The package separates **route declaration** (builder) from **route execution** (executor) into distinct units — same shape AdonisJS's HTTP router uses ([adonisjs/http-server `executor.ts`](https://github.com/adonisjs/http-server/blob/8.x/src/router/executor.ts)). The builder is class-based (stateful, accumulates declarations into its own internal routes map); the executor is a pure function (stateless per-request dispatch). `XrpcServer.#installRoutes` wires the two together at the boundary between phases — see the `XrpcServer` section below.

```ts
// Method type is derived from lexicon.type ('xrpc_query' / 'xrpc_procedure' / 'xrpc_subscription')
// rather than stored separately — the lexicon metadata already carries the discriminator atcute uses
// internally (see XRPCRouter.add's switch in @atcute/xrpc-server).

interface RouteAuthDecl {
  // True if .serviceAuth() was declared on this route (or on the surrounding group).
  // False = public (no verification runs).
  serviceAuth: boolean
  // Optional means: accept the route without auth; if a Bearer IS provided, verify
  // and 401 on failure. False (default when serviceAuth is true) means required.
  optional: boolean
}

interface RouteInfo {
  lexicon: XrpcLexicon
  handler:
    | XrpcRouteFn<any>
    | XrpcSubscriptionFn<any>
    | [LazyImport<any> | Constructor<any>, string?]
  // The accumulated auth declaration from any group + per-route .serviceAuth() calls.
  // Composed additively: route's flag OR'd with group's; optional flag OR'd from both.
  auth: RouteAuthDecl
}

/**
 * Per-route chainable builder. Returned from `router.xrpc.procedure / query / subscription`.
 * Extends Macroable so plugin packages can attach declarative methods at runtime
 * (e.g. `XrpcRoute.macro('rateLimit', fn)` from a future limiter integration).
 */
class XrpcRoute extends Macroable {
  /** @internal — only XrpcRouter constructs XrpcRoute instances. */
  constructor(private decl: RouteAuthDecl) {
    super()
  }

  /**
   * Declares that this route requires (or optionally accepts) a service-JWT Bearer.
   * Calling twice on the same route throws `RuntimeException` — likely a copy-paste
   * mistake worth surfacing immediately.
   */
  serviceAuth(options?: ServiceAuthOptions): this {
    if (this.decl.serviceAuth) {
      throw new RuntimeException(
        'XRPC route called .serviceAuth() twice — remove the duplicate call'
      )
    }
    this.decl.serviceAuth = true
    this.decl.optional ||= !!options?.optional
    return this
  }
}

/**
 * Chainable builder returned from `router.xrpc.group(callback)`. Carries a reference
 * to the routes registered inside the group's callback so `.serviceAuth()` can fan
 * the flag out to each. Extends Macroable for plugin extensibility.
 */
class XrpcRouteGroup extends Macroable {
  /** @internal — only XrpcRouter constructs XrpcRouteGroup instances. */
  constructor(
    private groupDecl: RouteAuthDecl,
    private routes: XrpcRoute[]
  ) {
    super()
  }

  /**
   * Applies service-JWT auth to every route declared inside the group callback.
   * Calling on a route that already declared `.serviceAuth()` throws — the duplicate
   * detection catches the "group sets it AND each route sets it" mistake.
   */
  serviceAuth(options?: ServiceAuthOptions): this {
    if (this.groupDecl.serviceAuth) {
      throw new RuntimeException(
        'XRPC group called .serviceAuth() twice — remove the duplicate call'
      )
    }
    this.groupDecl.serviceAuth = true
    this.groupDecl.optional ||= !!options?.optional
    for (const route of this.routes) {
      // Delegate to route.serviceAuth() so the route-level duplicate check fires
      // if a route inside also declared it (group + route both setting it is a
      // declaration error worth surfacing).
      route.serviceAuth(options)
    }
    return this
  }
}

/**
 * Build-time: accumulates route declarations and owns the routes map.
 * Doesn't know about the underlying XRPCRouter or the executor — both are
 * "lifted up" to the provider, which orchestrates commit independently.
 *
 * The routes map lives on the builder rather than a separate registry class —
 * the registry was over-encapsulation for a 100-line class. Read accessors
 * (`committed`, `operations`) cover the cases the executor and
 * `XrpcServer.#installRoutes` need to reach in for; the rest stays private.
 */
class XrpcRouter extends Macroable {
  #operations = new Map<string, RouteInfo>()
  #committed = false
  // Group context is a stack of "in-progress group declarations" — each group()
  // callback pushes its accumulator before invoking the callback, then pops on exit.
  // Routes registered inside the callback inherit the top-of-stack into their own
  // RouteAuthDecl. Nested groups are explicitly not supported in v1 (the stack is
  // always either empty or length 1); the array form keeps the implementation
  // future-extensible without breaking the current invariant.
  #groupContext: { decl: RouteAuthDecl; routes: XrpcRoute[] }[] = []

  // === Public registration API (called from start/routes.ts) ===

  /**
   * Declares a route group. The returned `XrpcRouteGroup` exposes `.serviceAuth(...)`
   * to apply service-JWT auth to every route declared inside the callback. Auth
   * composition is **additive**: a route's effective auth flag = group.serviceAuth ||
   * route.serviceAuth; effective optional = group.optional || route.optional.
   *
   * Nesting groups within groups is rejected in v1.
   */
  group(callback: () => void): XrpcRouteGroup {
    if (this.#committed) throw new RuntimeException('Cannot declare XRPC groups after commit')
    if (this.#groupContext.length > 0) {
      throw new RuntimeException('Nested xrpc.group() is not supported in v1')
    }

    const groupDecl: RouteAuthDecl = { serviceAuth: false, optional: false }
    const groupRoutes: XrpcRoute[] = []
    this.#groupContext.push({ decl: groupDecl, routes: groupRoutes })
    try {
      callback()
    } finally {
      this.#groupContext.pop()
    }

    // The group instance carries its own `decl` plus the list of routes registered
    // inside its callback. When .serviceAuth() is called on the group, it sets its
    // own decl flag (so future state inspection sees the group-level intent) AND
    // fans the flag out to the already-registered routes' decls.
    return new XrpcRouteGroup(groupDecl, groupRoutes)
  }

  procedure<L extends XrpcProcedureLexicon, T extends Constructor<any>>(
    lexicon: L,
    handler: XrpcRouteFn<L> | [LazyImport<T> | T, GetXrpcControllerHandlers<T, L>?]
  ): XrpcRoute {
    return this.#register(lexicon, handler)
  }

  query<L extends XrpcQueryLexicon, T extends Constructor<any>>(
    lexicon: L,
    handler: XrpcRouteFn<L> | [LazyImport<T> | T, GetXrpcControllerHandlers<T, L>?]
  ): XrpcRoute {
    return this.#register(lexicon, handler)
  }

  subscription<L extends XrpcSubscriptionLexicon, T extends Constructor<any>>(
    lexicon: L,
    handler: XrpcSubscriptionFn<L> | [LazyImport<T> | T, GetXrpcControllerHandlers<T, L>?]
  ): XrpcRoute {
    return this.#register(lexicon, handler)
  }

  #register(lexicon: XrpcLexicon, handler: RouteInfo['handler']): XrpcRoute {
    if (this.#committed) throw new RuntimeException('Cannot register XRPC routes after commit')
    const auth = this.#newAuthDecl()
    const route = new XrpcRoute(auth)
    this.#operations.set(lexicon.id, { lexicon, handler, auth })
    this.#groupContext.at(-1)?.routes.push(route)
    return route
  }

  /** Constructs a fresh RouteAuthDecl, inheriting the active group context (if any). */
  #newAuthDecl(): RouteAuthDecl {
    const active = this.#groupContext.at(-1)?.decl
    return {
      serviceAuth: active?.serviceAuth ?? false,
      optional: active?.optional ?? false,
    }
  }

  /** True after commit. */
  get committed(): boolean {
    return this.#committed
  }

  get operations(): Record<string, RouteInfo> {
    return Object.fromEntries(this.#operations.entries())
  }

  /**
   * Transitions the builder to its frozen state. Idempotent silent no-op if
   * already committed (safe to call defensively from anywhere). After commit,
   * declaration methods (procedure / query / subscription / group) throw
   * RuntimeException. Callers that need to know whether a transition actually
   * happened should consult `builder.committed` before and after.
   */
  commit(): void {
    if (this.#committed) return
    this.#committed = true
  }
}
```

### `XrpcServer` — internal dispatch orchestrator

`XrpcServer` lives in `src/xrpc_server.ts` and owns the dispatch-side state: the atcute `XRPCRouter`, the WebSocket helper from `createNodeWebSocket()`, and the shared executor. It exposes a single public lifecycle method, `start()`, that the provider calls during `ready()` after `router.xrpc.commit()` has frozen the builder. This shape mirrors how AdonisJS core's [ignitor/http.ts](https://github.com/adonisjs/core/blob/7.x/src/ignitor/http.ts) drives `HttpServerProcess.start()`.

`XrpcServer` is **not** in `services/` — it's an internal class, never exposed to consumers. The consumer-facing facade is `XrpcService` (see below).

```ts
class XrpcServer {
  #app: ApplicationService
  #xrpcRouter: XRPCRouter
  #ws: ReturnType<typeof createNodeWebSocket>
  #executor: SharedXrpcExecutor

  constructor(deps: {
    app: ApplicationService
    xrpcRouter: XRPCRouter
    ws: ReturnType<typeof createNodeWebSocket>
    executor: SharedXrpcExecutor
  }) {
    this.#app = deps.app
    this.#xrpcRouter = deps.xrpcRouter
    this.#ws = deps.ws
    this.#executor = deps.executor
  }

  /**
   * Starts the XRPC dispatch layer: acquires the Adonis router + appServer +
   * nodeServer from the container, wires the frozen builder's routes into
   * atcute's XRPCRouter, and installs the WebSocket upgrade handler.
   *
   * Caller (provider.ready()) must have already called router.xrpc.commit().
   * No-ops cleanly if no nodeServer is available (non-HTTP environments).
   */
  async start(): Promise<void> {
    const router = await this.#app.container.make('router')
    const appServer = await this.#app.container.make('server')
    const nodeServer = appServer.getNodeServer()
    if (!nodeServer) return

    this.#installRoutes(router.xrpc)
    this.#installWebSocketHandler(nodeServer, appServer)
  }

  #installRoutes(xrpc: XrpcRouter): void {
    if (!xrpc.committed) {
      throw new RuntimeException(
        'XRPC builder must be committed before installing routes; call router.xrpc.commit() first',
      )
    }
    for (const route of Object.values(xrpc.operations)) {
      switch (route.lexicon.type) {
        case 'xrpc_procedure':
          this.#xrpcRouter.addProcedure(route.lexicon, { handler: this.#executor })
          break
        case 'xrpc_query':
          this.#xrpcRouter.addQuery(route.lexicon, { handler: this.#executor })
          break
        case 'xrpc_subscription':
          this.#xrpcRouter.addSubscription(route.lexicon, { handler: this.#executor })
          break
      }
    }
  }

  #installWebSocketHandler(nodeServer: http.Server, appServer: AdonisServer): void {
    // Listener #1 — ours, registered first so its ALS context is established before
    // atcute's processing runs in the same emit('upgrade', ...) execution.
    nodeServer.on('upgrade', (req) => {
      if (!req.url?.startsWith('/xrpc/')) return

      const synthRes = new ServerResponse(req)
      const httpRequest = appServer.createRequest(req, synthRes)
      const httpResponse = appServer.createResponse(req, synthRes)
      const resolver = this.#app.container.createResolver()
      const httpCtx = appServer.createHttpContext(httpRequest, httpResponse, resolver)

      // Mirror container_bindings_middleware bindings for the subscription path:
      resolver.bindValue(HttpContext, httpCtx)
      resolver.bindValue(Logger, httpCtx.logger)

      httpContextStore.enterWith(httpCtx)
    })

    // Listener #2 — atcute's, registered second. Inherits our ALS store via the
    // synchronous emit chain → async promise continuations.
    this.#ws.injectWebSocket(nodeServer, this.#xrpcRouter)
  }

  /** Read accessor for the dispatch middleware (XrpcDispatchMiddleware). */
  get router(): XRPCRouter {
    return this.#xrpcRouter
  }
}

/**
 * Run-time: the shared executor function — one per package instance, registered
 * with atcute for every route. Constructed once at provider boot() with all
 * dispatch-time dependencies captured in closure scope. Matches Adonis's
 * functional executor pattern (src/router/executor.ts) — stateless per-request,
 * receives its dependencies via the surrounding closure.
 */
type SharedXrpcExecutor = (
  atcuteCtx: UnknownOperationContext | UnknownSubscriptionContext,
) => Promise<Response | undefined> | AsyncIterable<unknown>

function createXrpcExecutor(deps: {
  operations: Record<Nsid, RouteInfo>
  xrpc: XrpcService
  serviceJwtVerifier: ServiceJwtVerifier
  xrpcSerializer: XrpcSerializer
}): SharedXrpcExecutor {
  const { builder, xrpc, serviceJwtVerifier, xrpcSerializer } = deps

  return async (atcuteCtx) => {
    const httpCtx = HttpContext.getOrFail() ?? httpContextStore.getStore()!

    // atcute doesn't forward the NSID to the handler — its router parses NSID
    // internally to look up the registered route, but the context object only
    // carries request/signal/params. We re-derive the NSID from the URL using
    // the same slice atcute uses internally:
    const nsid = new URL(atcuteCtx.request.url).pathname.slice('/xrpc/'.length)
    const route = operations[nsid]

    if (!route) // invariant error? InternalServerError?

    // Auth: construct an XrpcAuth holding the service-JWT verifier. Verification
    // runs lazily on first resolve() call. For required-auth routes
    // (route.auth.serviceAuth && !route.auth.optional), we pre-trigger after the
    // context is built to preserve fail-fast semantics. Public routes
    // (!route.auth.serviceAuth) get an XrpcAuth with no verifier — resolve() returns
    // null without inspecting the request, so any Authorization header is silently
    // ignored.
    const auth = new XrpcAuth(
      atcuteCtx.request,
      route.lexicon,
      route.auth,
      route.auth.serviceAuth ? serviceJwtVerifier : null,
    )

    const xrpcCtx = new XrpcContext({
      httpCtx,
      lexicon: route.lexicon,
      request: atcuteCtx.request,
      input: 'input' in atcuteCtx ? atcuteCtx.input : undefined,
      params: atcuteCtx.params,
      signal: atcuteCtx.signal,
      auth,
    })
    httpCtx.containerResolver.bindValue(XrpcContext, xrpcCtx)

    // Pre-trigger verification for required-auth routes — fail-fast before
    // handler runs. Optional-auth and public routes defer resolution to
    // first handler access (or never, for public routes that ignore auth).
    if (route.auth.serviceAuth && !route.auth.optional) {
      await auth.resolveOrFail() // throws AuthRequiredError; caught by outer try/catch
    }

    const handler = isControllerRef(route.handler)
      ? await resolveControllerMethod(httpCtx.containerResolver, route.handler)
      : route.handler

    // Enter the XrpcContext ALS scope before invoking the handler — XrpcContext.getOrFail()
    // reads from this ALS, so anything called downstream from the handler (services, models,
    // helpers) can access the current XRPC context without explicit parameter threading. The
    // store stays alive through the handler's async continuations.
    return XrpcContext.als.run(xrpcCtx, async () => {
      try {
        if (route.lexicon.type === 'xrpc_subscription') {
          return wrapSubscriptionIterator(handler(xrpcCtx), httpCtx, xrpcSerializer)
        }
        const result = await handler(xrpcCtx)
        return await xrpcSerializer.serializeWithoutWrapping(result, httpCtx.containerResolver)
      } catch (err) {
        const xrpcError = err instanceof XrpcError ? err : new InternalServerError(err.message)
        const errorHandler = await xrpc.getRegisteredErrorHandler()
        await errorHandler?.report(err, httpCtx)
        throw xrpcError
      }
    })
  }
}
}
```

The user's handler signature stays `(ctx: XrpcContext<typeof reports.createReport>) => ...` — TypeScript still type-checks that. The executor operates on `XrpcContext<any>` (broad runtime view); when it invokes the user's handler, TypeScript's structural typing accepts the cast because the registered handler's signature is its source of truth.

Memory comparison for N routes: before is N closures each holding lexical references — typically hundreds of bytes per closure plus captured object graphs. After is N entries in a Map (each a small POJO) plus one shared executor function. For N=200 routes, roughly an order of magnitude reduction in per-route memory footprint. Not transformative for small apps; meaningful for labelers or AppViews proxying entire lexicon namespaces.

The registry has secondary benefits too: the `list:xrpc:routes` ace command iterates the registry instead of asking atcute to enumerate; phase-2 `indexXrpc` codegen reads the registry to emit base classes; per-route metrics lookups become `Map.get` instead of closure-captured state.

The XRPCRouter's `middlewares` slot in `XRPCRouterOptions` is **not** used for `XrpcContext` construction: FetchMiddleware sees only the raw `Request` and runs before atcute's per-route resolution, so it doesn't have the parsed `input`/`params` needed to build a typed `XrpcContext<L>`. `XRPCRouterOptions.handleException` and `XRPCRouterOptions.handleSubscriptionException` are the right hooks for wire-format rendering of caught errors, and are configured when the package constructs the singleton `XRPCRouter`.

### Handler shapes: inline and controller-reference

Both shapes ship in v1. Inline handlers get TypeScript inference of the lexicon's typed `input` / `params` / `auth` shapes for free; controller-reference handlers need an explicit `XrpcContext<typeof lexicon>` annotation on the method signature (until v1 phase 2 codegen lands — see below).

```ts
// Inline — fully inferred
router.xrpc.procedure(reports.createReport, async (ctx) => {
  // ctx.input is typed as InferInput<typeof reports.createReport>
  const { reasonType, subject } = ctx.input
  return { reportId: '...' }
})

// Controller reference — explicit annotation
router.xrpc.procedure(reports.createReport, [ReportsController, 'create'])

// controllers/reports_controller.ts
class ReportsController {
  async create(ctx: XrpcContext<typeof reports.createReport>) {
    const { reasonType, subject } = ctx.input
    return { reportId: '...' }
  }
}
```

The trade-off is real but small: inline expresses the "I want full inference, terse code" path; controller-reference handles the "I want DI, testability, separation-of-concerns" path. Adonis's own router supports both for plain HTTP routes; this package matches that convention.

### Authentication

XRPC routes declare auth via a chainable `.serviceAuth(options?)` method on the route builder returned from `procedure` / `query` / `subscription`. v1 ships a single auth mode:

- **Service JWT** — inter-service Bearer token; verified by `ServiceJwtVerifier` from `@atcute/xrpc-server/auth` against the configured `serviceDid` (the `aud` claim) and the route's NSID (the `lxm` claim). On success, `ctx.auth` resolves to `{ kind: 'service', service: Did, claims: VerifiedServiceJwt }`.

The discriminated-union shape (`{ kind: 'service'; ... }`) is single-arm in v1 but anticipates a future `{ kind: 'oauth'; ... }` arm — that's a non-breaking type expansion when AT Protocol OAuth verification becomes a solved problem in the ecosystem. See _Why v1 ships service-only auth_ below.

```ts
// Required service auth (Ozone admin actions, mod-tooling RPCs, etc.):
router.xrpc.procedure(reports.createReport, [ReportsController, 'create']).serviceAuth()

// Optional service auth (PDS-proxying pattern — accept the request without auth,
// but if a service JWT IS provided, verify and populate ctx.auth):
router.xrpc.query(actor.getProfile, [ProfilesController, 'show']).serviceAuth({ optional: true })

// Public — no .serviceAuth() call. Default for any route that doesn't chain it:
router.xrpc.subscription(labels.subscribeLabels, [LabelsController, 'subscribe'])
router.xrpc.query(labels.queryLabels, [LabelsController, 'index'])
```

#### The three states

The combination of `.serviceAuth()` declaration + `optional` flag produces one of three runtime behaviors:

| `.serviceAuth(...)` call           | State        | Bearer-token behavior                                                                                                                        |
| ---------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| none                               | **public**   | Ignored even if present. Verification never runs.                                                                                            |
| `.serviceAuth()`                   | **required** | Verified. Absent → 401. Invalid → 401. Valid → `ctx.auth` populated.                                                                         |
| `.serviceAuth({ optional: true })` | **optional** | Verified if present. Absent → request proceeds (`ctx.auth.resolve()` returns null). Present-and-invalid → 401. Valid → `ctx.auth` populated. |

These map onto the atproto Lexicon spec's three `auth` values (`absent` / `'standard'` / `'optional'`). Lexicon-driven derivation is gated on upstream changes — see _Future work_.

#### Why "public" silently ignores Authorization headers

Real-world atproto clients (`@atproto/api`, `@atcute/client`) attach session-level credentials to every request once authenticated — they don't gate header attachment by endpoint. A logged-in Bluesky-app instance hits `com.atproto.identity.resolveHandle` (a canonically-public endpoint) with its OAuth token in the Authorization header constantly. Strict-reject behavior would 401 every such request. So the framework treats Authorization headers on public routes as effectively absent: it doesn't verify, doesn't 401, doesn't populate `ctx.auth`. The header may as well not be there.

Consumers who need to _prevent_ token leakage to public endpoints should enforce that at the client layer (don't send tokens where they don't belong) or at a separate request-validation middleware — not at the route-declaration layer. v1 ships no opt-in strict-reject knob; if a consumer use case demands it, add then.

#### Grouping

When multiple routes share an auth profile, `router.xrpc.group(callback)` declares a callback inside which routes are accumulated, and the returned `XrpcRouteGroup` exposes `.serviceAuth(...)` to apply service-JWT auth to every route declared inside:

```ts
// Group declares default; routes inside inherit:
router.xrpc
  .group(() => {
    router.xrpc.procedure(reports.createReport, [ReportsController, 'create'])
    router.xrpc.procedure(reports.resolveReport, [ReportsController, 'resolve'])
  })
  .serviceAuth()

// Group declares optional service auth; routes inside inherit:
router.xrpc
  .group(() => {
    router.xrpc.query(actor.getProfile, [ProfilesController, 'show'])
  })
  .serviceAuth({ optional: true })
```

`.serviceAuth()` declared twice on the same route, twice on the same group, or split between a group and a route inside it throws `RuntimeException` at declaration time — likely a copy-paste mistake worth surfacing immediately. (When the future `.oauth()` method lands, group + route can stack different modes additively; in v1 with one method, every duplicate is genuinely a mistake.)

v1 group surface is `.serviceAuth()` only. `.prefix()` is meaningless for XRPC (paths are fixed at `/xrpc/<NSID>`); `.middleware()` is YAGNI until a consumer hits a real need. Nested groups (a `group()` call inside another `group()` callback) throw — inheritance semantics are murky and easy to add later if a use-case appears.

#### Per-call options (extension point)

`.serviceAuth(options?)` carries a per-call options object intended as the extension point. v1's only inhabitant is `{ optional: true }`. Future per-mode options can slot in naturally — e.g. an issuer allowlist:

```ts
// Hypothetical future per-call option:
router.xrpc
  .procedure(admin.purge, [AdminController, 'purge'])
  .serviceAuth({ iss: ['did:plc:ozone-instance'] }) // only this issuer
```

The `lxm` JWT claim is auto-derived from the route's NSID — there's no scenario where a token's `lxm` should differ from the route it's calling, so it's never per-route-configurable. The `aud` claim is the package-level `serviceDid` config, also not per-route — a service is one DID.

#### Dispatch behavior

At dispatch time, for each request:

1. **Public route** (`!route.auth.serviceAuth`): no verification path runs. `ctx.auth.resolve()` returns null synchronously. Bearer headers in the request are not inspected.
2. **Required route** (`route.auth.serviceAuth && !route.auth.optional`): the dispatcher pre-triggers `auth.resolveOrFail()` after building the context. The verifier runs against the Bearer header; throws `AuthRequiredError` if verification fails or no Bearer was provided. The handler runs only if resolution succeeded.
3. **Optional route** (`route.auth.serviceAuth && route.auth.optional`): dispatcher does NOT pre-trigger. Handler invokes `await ctx.auth.resolve()` to read the discriminated-union result (`{ kind: 'service'; ... } | null`). Absent Bearer → null; present-and-invalid Bearer → throws `AuthRequiredError` (caught at dispatch boundary).

#### Why v1 ships service-only auth

Server-side AT Protocol OAuth verification isn't a solved problem in the ecosystem yet. AT Protocol OAuth tokens are **opaque** — they're not JWTs, can't be verified locally against a known signing key, and require introspection (or similar) to validate. As of the spec date, the introspection pattern hasn't been settled across the ecosystem, and the reference implementations don't implement it:

- **`@atproto/bsky`'s `AuthVerifier`** (`packages/bsky/src/auth-verifier.ts`) handles service JWTs and an explicitly-`@NOTE temporarily` entryway-session-token stopgap — `entrywaySession` accepts `at+jwt`-typed tokens issued by the entryway service to "shed load from PDS instances," locally-verifiable against a configured public key. This isn't OAuth; it's a Bluesky-specific workaround.
- **`@atproto/ozone`'s `AuthVerifier`** (`packages/ozone/src/auth-verifier.ts`) handles service JWTs plus HTTP Basic admin credentials. No OAuth path.
- **`@atcute/xrpc-server/auth`** ships only `ServiceJwtVerifier`. There's no `OAuthVerifier`-equivalent exposing a server-side surface for opaque-token introspection — `@atcute/oauth-node-client` exists primarily for the outbound OAuth-flow side (browser/node client), not for accepting tokens server-side.

Until either (a) the ecosystem standardizes a server-side introspection pattern that consumer packages can implement, or (b) `@atcute/*` ships a verifier for opaque tokens that this package can wire up, the OAuth side of the spec is forward-looking infrastructure that nothing can fulfill. Rather than ship `.auth('oauth')` as dead infrastructure in v1, this package narrows to `.serviceAuth()` and adds an `.oauth()` (or equivalent) sibling method in a later minor when the ecosystem catches up. The forward-compat path is non-breaking: adding `.oauth()` to the route/group builders is purely additive, and the `XrpcAuthResult` discriminated union grows a new arm.

> **Architectural-direction note** (related but distinct): the atproto Lexicon spec doesn't currently declare per-method auth requirements expressively enough to distinguish auth modes — the current `auth` field admits `'standard'` / `'optional'` / absent, treating "authenticated" as a single category. The [XRPC specification](https://atproto.com/specs/xrpc) lists per-mode auth declarations as future work, and [`mary-ext/atcute#76`](https://github.com/mary-ext/atcute/issues/76) tracks atcute exposing whatever shape eventually lands. The builder-based `.serviceAuth()` (and future `.oauth()`) declarations are load-bearing for the foreseeable future — not just until atcute#76 closes, since the Lexicon-level work is upstream of both that issue _and_ the opaque-token / introspection story. Once everything lands, this package can switch to lexicon-driven auth in a non-breaking way: builder calls continue to work for routes whose lexicons don't declare auth explicitly, with lexicon-declared auth taking precedence where present.

### Lifecycle phases

The `XrpcRouter.commit()` boundary establishes a well-defined ordering between route declaration and active dispatch. Concretely, in app boot order:

1. **Provider `register()`** (synchronous) — package installs the `router.xrpc` macroable getter, installs the `HttpContext.xrpc` macroable getter, and registers container singleton factories for the `XrpcService` and the `XrpcServer`. No objects are constructed yet — the factories defer construction until first resolution. This is the synchronous-only phase per AdonisJS convention.
2. **Provider `boot()`** (async) — package reads `defineConfig({ serviceDid, resolver })`, constructs the `ServiceJwtVerifier`, calls `createNodeWebSocket()` from `@atcute/xrpc-server-node` to get the WebSocket helper, constructs the `XRPCRouter` instance with `{ websocket: ws.adapter, handleException, handleSubscriptionException }` wired, constructs the `XrpcSerializer` and the shared executor (closing over the builder reference, the verifier, the `XrpcService` for error-handler resolution, and the serializer). Constructs the `XrpcServer` with `{ app, xrpcRouter, ws, executor }`. The builder's routes map is still empty; the `XRPCRouter` has no routes yet. The provider stashes the `XrpcServer` instance as a private field for use in `ready()`.
3. **Preloads** — `start/routes.ts` (and any other preload) runs. `router.xrpc.{procedure, query, subscription}(...)` calls populate the builder's registry. The `XRPCRouter` still has no routes; the builder's public methods write only to the registry.
4. **`hooks.init`** — runs after preloads. The phase-2 codegen hook (`indexXrpc()`) reads the now-populated registry to emit typed abstract base classes for any controller-reference registrations. The registry is closed-to-additions at this point conceptually, but `commit()` hasn't fired yet.
5. **Provider `ready()`** — calls `router.xrpc.commit()` to freeze the builder (after which declaration methods throw), then `await this.#xrpcServer.start()`. `XrpcServer.start()` acquires the Adonis router, appServer, and nodeServer from the container, then internally wires the frozen routes into atcute's `XRPCRouter` (`#installRoutes`) and installs the WebSocket upgrade handler (`#installWebSocketHandler` — registers the synthetic-HttpContext + ALS upgrade listener BEFORE atcute's, then calls `ws.injectWebSocket(nodeServer, xrpcRouter)`).
6. **First request** — the `XrpcDispatchMiddleware` (or the upgrade-event listener for subscriptions) hands the request to the committed `XRPCRouter`, which routes to the shared executor function.

After commit, `procedure` / `query` / `subscription` / `group` all throw `RuntimeException`. This is the same boundary AdonisJS's `router.commit()` establishes — once routes are active, the declaration surface is sealed.

**HMR**: AdonisJS's HMR restarts the entire app process when `start/routes.ts` changes, which means the `XrpcRouter` is reconstructed from scratch and `commit()` re-runs naturally. No `reset()` method needed — the commit pattern works cleanly under HMR by virtue of the framework's restart semantics.

### Dispatch: HTTP middleware (procedure + query)

```ts
// start/kernel.ts (consumer)
server.use([
  () => import('#middleware/container_bindings_middleware'), // standard Adonis pattern
  () => import('@adonisjs/cors/cors_middleware'),
  () => import('@thisismissem/adonisjs-atproto-xrpc/middleware'),
  () => import('@adonisjs/static/static_middleware'),
  () => import('@adonisjs/vite/vite_middleware'),
  () => import('@adonisjs/inertia/inertia_middleware'),
])
```

Middleware implementation:

```ts
export default class XrpcDispatchMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (!ctx.request.url().startsWith('/xrpc/')) {
      return next()
    }

    // Bridge Adonis HttpRequest -> Web Request for atcute's router.fetch()
    const webRequest = adonisRequestToWebRequest(ctx.request)
    const xrpcRouter = await ctx.containerResolver.make(XRPC_ROUTER_BINDING)
    const webResponse = await xrpcRouter.fetch(webRequest)
    return writeWebResponseToAdonisResponse(webResponse, ctx.response)
  }
}
```

The middleware short-circuits the rest of the Adonis pipeline on a match. Non-matching requests pass through normally. The Adonis-request ↔ Web-request bridging functions construct a `Request` from the Adonis `Request` (URL, method, headers, body stream) and write the resulting `Response` back to the Adonis `Response`.

The `XrpcContext` construction happens inside the registered handler closure (where the lexicon and atcute-parsed input/params are available), not in the middleware itself. For HTTP-triggered routes, the handler closure accesses the triggering `HttpContext` via Adonis's own ALS (`HttpContext.getOrFail()`), which means consumers must enable `useAsyncLocalStorage: true` in `config/app.ts` — this becomes a documented prerequisite. For subscription routes, no Adonis HttpContext exists, so the handler closure reads from the package's own `httpContextStore: AsyncLocalStorage<HttpContext>` (populated via `.enterWith()` at the Node `'upgrade'` event with the synthetic HttpContext built from the upgrade `IncomingMessage`).

The two paths use different mechanisms because each path's lifecycle is different: HTTP-triggered routes inherit Adonis's existing pipeline-managed HttpContext; subscriptions construct their own HttpContext outside any Adonis pipeline. The asymmetry is structural, not stylistic.

### Dispatch: WebSocket upgrade (subscription)

WebSocket connections don't traverse HTTP middleware — they're handled by the Node server's `'upgrade'` event. The upgrade-handling logic lives inside `XrpcServer.#installWebSocketHandler` (called by `XrpcServer.start()` during the provider's `ready()`):

- Listener #1 — ours, registered FIRST so it runs first in the synchronous chain. It builds the HttpContext from the upgrade request and `enterWith()`s it on the ALS, making it available throughout the rest of atcute's processing chain (which runs synchronously in the same `emit('upgrade', ...)` execution, then asynchronously via promise continuations that inherit the ALS context).
- Listener #2 — atcute's, registered SECOND via `ws.injectWebSocket(nodeServer, xrpcRouter)`. Its emit-time execution inherits our ALS store via the synchronous-chain → async-continuation propagation. The same `ws` object was created during `boot()` (so its `ws.adapter` could be passed into the `XRPCRouter` constructor); `XrpcServer` reuses it for the upgrade install.

The provider's `ready()` itself stays minimal — it commits the builder and delegates the rest to `XrpcServer.start()`:

```ts
async ready() {
  if (this.app.getEnvironment() !== 'web') return

  const router = await this.app.container.make('router')
  router.xrpc.commit()

  await this.#xrpcServer.start()
}
```

The full upgrade-listener implementation lives in `XrpcServer.#installWebSocketHandler` (see the `XrpcServer` section above).

The `enterWith()`-vs-`run()` choice: the Node docs prefer `run()` because `enterWith()` persists for the entire synchronous execution including subsequent event handlers. In our case this is precisely the desired behavior — atcute's listener fires next in the same synchronous chain and needs to inherit the store. The "leak" the docs warn about is consumer-registered listeners on the same event inheriting our store; the store value is the same `IncomingMessage` they already receive as an argument, so the leak is information-equivalent. The package keeps the `wss` reference private to discourage consumers from adding their own `'connection'` listeners on it.

### Subscription dispatch — executor branches

Subscription dispatch uses the same shared executor described earlier — there's no separate "subscription wrapper" function, just a method-specific branch within the executor. When `route.lexicon.type === 'xrpc_subscription'`, the executor invokes the user's `AsyncIterable`-returning handler and wraps the iterator with a transforming generator that serializes each yielded value before atcute encodes it as a CBOR frame:

```ts
// Within the executor, for the subscription branch:
if (route.lexicon.type === 'xrpc_subscription') {
  return wrapSubscriptionIterator(userHandler(xrpcCtx), httpCtx, xrpcSerializer)
}

// wrapSubscriptionIterator is also a shared helper, not per-route:
async function* wrapSubscriptionIterator(
  iterable: AsyncIterable<unknown>,
  httpCtx: HttpContext,
  serializer: XrpcSerializer
) {
  try {
    for await (const value of iterable) {
      yield await serializer.serializeWithoutWrapping(value, httpCtx.containerResolver)
    }
  } catch (err) {
    const xrpcError = err instanceof XrpcError ? err : new InternalServerError(err.message)
    await registeredErrorHandler?.report(err, httpCtx)
    throw new XRPCSubscriptionError({ error: xrpcError.errorName, message: xrpcError.message })
  }
}
```

The procedure / query branch handles errors similarly via the dispatcher's outer try/catch, but throws an `XrpcError` for atcute's `handleException` hook to encode as the JSON wire-format response. Subscriptions translate `XrpcError` → `XRPCSubscriptionError` so atcute's `handleSubscriptionException` hook (configured at XRPCRouter construction time) emits the error frame and closes the stream.

### `XrpcContext` shape

`XrpcContext`, `XrpcAuth`, `XrpcStream`, and `XrpcResponse` all extend `Macroable` — same rationale as the route builders: plugin packages can attach declarative or accessor methods at runtime (e.g., a future tracing integration could register `XrpcContext.macro('span', fn)`) without this package shipping the dependency. Mirrors how Adonis's own `HttpContext`, `Request`, `Response` are Macroable. Constructors on all four are `@internal` — instances are constructed by dispatch (or by `XrpcContextFactory` for tests), never by consumers.

```ts
class XrpcContext<L extends XrpcLexicon> extends Macroable {
  /** @internal — instances constructed by dispatch or XrpcContextFactory. */
  constructor(params: { /* see executor closure for the shape */ }) { super(); /* ... */ }

  /**
   * Internal ALS holding the current XrpcContext instance. The executor calls
   * `XrpcContext.als.run(xrpcCtx, () => handler(xrpcCtx))` before invoking the
   * user's handler, so anything called downstream from the handler can access
   * the current context via `XrpcContext.getOrFail()` without explicit threading.
   */
  static readonly als: AsyncLocalStorage<XrpcContext<XrpcLexicon>>

  /**
   * Static accessor for the current XRPC context. Works in both HTTP-triggered
   * and subscription-triggered paths (single ALS, populated by the executor).
   * Throws RuntimeException if called outside an XRPC handler's call stack.
   * Preferred over `HttpContext.getOrFail()` inside XRPC routes and code called
   * downstream from them — see the "HTTP-context constraint for subscriptions"
   * section for the asymmetry that motivates this.
   */
  static getOrFail(): XrpcContext<XrpcLexicon>

  // HttpContext-mirrored properties (inherited from the triggering HttpContext for HTTP-side
  // dispatch, or from the synthetic HttpContext for subscriptions):
  request: Request // Fetch Request (atcute speaks Fetch)

  /**
   * The output channel for this handler. Conditionally typed on the lexicon kind:
   * - For procedure / query lexicons: `XrpcResponse<L>` — typed against the lexicon's
   *   output schema. Use `.body(value)`, `.status(code)`, `.header(...)`, `.redirect(...)`.
   * - For subscription lexicons: `XrpcStream<L>` — typed against the lexicon's message refs.
   *   Use `.message(ref, payload)` from inside the async-generator handler, plus `.aborted`
   *   / `.signal` for client-disconnect detection.
   *
   * The unified `response` slot replaces the previous `response` + `stream` split — handlers
   * always reach for `ctx.response` regardless of route kind, and TypeScript narrows the
   * shape via the lexicon's discriminator. This also sidesteps the "synthetic HttpContext
   * has a degenerate HttpResponse" concern: XRPC handlers never reach for `ctx.httpContext.response`
   * in subscription paths because they have a typed `ctx.response` that's the right shape.
   */
  response: L extends XrpcSubscriptionLexicon ? XrpcStream<L> : XrpcResponse<L>
  logger: Logger // request-scoped
  containerResolver: ContainerResolver
  requestId: string // sourced from HttpRequest.id() (x-request-id header) or generated if absent

  /**
   * Direct access to the underlying HttpContext. Use for cases the mirrored
   * properties don't cover (session, Adonis's auth, etc.). Note: for subscription
   * routes this is a *synthetic* HttpContext built at the 'upgrade' event — many
   * middleware-installed properties (session, cookies, csrf) won't be populated,
   * and `httpContext.response` is Adonis's standard `HttpResponse` whose writes are
   * silent no-ops post-upgrade (the socket has been hijacked for WebSocket). Don't
   * reach for `ctx.httpContext.response` from subscription handlers — use `ctx.response`
   * (the typed `XrpcStream`) instead.
   */
  get httpContext(): HttpContext

  // XRPC-specific properties:
  input: InferInput<L> // typed body input for procedures
  params: InferParams<L> // typed query parameters
  lexicon: L // the lexicon spec object (handler self-reference)

  // Auth — populated by dispatch when the route has a `.serviceAuth(...)` declaration:
  auth: XrpcAuth
}

// Discriminated union — single-arm in v1. The `kind` discriminator stays so adding a
// future `{ kind: 'oauth'; ... }` arm (when AT Protocol OAuth verification ships) is a
// non-breaking type expansion — handler code that narrows on `auth.kind === 'service'`
// keeps working unchanged.
type XrpcAuthResult = { kind: 'service'; service: Did; claims: VerifiedServiceJwt }

// Type guard — exported from `@thisismissem/adonisjs-atproto-xrpc/services/xrpc` (with
// re-exports from the main entrypoint). Implementation is a one-liner over `.kind`; the
// value is in the assertion-function signature so TypeScript narrows correctly inside
// callers that hold an XrpcAuthResult | null (e.g. from a previous `await ctx.auth.resolve()`).
// Trivially-true on any non-null result in v1; future-proof against the `'oauth'` arm landing.
declare function isService(
  auth: XrpcAuthResult | null | undefined
): auth is Extract<XrpcAuthResult, { kind: 'service' }>

class XrpcAuth extends Macroable {
  /**
   * @internal — constructed by the dispatcher with the request, the matched lexicon,
   * the route's accumulated auth declaration, and the configured service-JWT verifier
   * (or null for public routes). Verification runs lazily on first resolve() call and
   * is memoized — required-auth routes pre-trigger via the dispatcher for fail-fast
   * semantics; optional-auth routes verify on-demand.
   */
  constructor(
    request: Request,
    lexicon: XrpcLexicon,
    decl: RouteAuthDecl,
    verifier: ServiceJwtVerifier | null
  )

  /**
   * Resolves the auth state. Memoized — subsequent calls return cached result.
   *
   * Without a mode argument:
   * - Returns the discriminated union ({ kind: 'service', ... }) if a Bearer was
   *   provided and verified.
   * - Returns null if no Bearer was provided (only reachable for optional-auth /
   *   public routes; required-auth routes throw earlier during dispatch's pre-trigger).
   * - Throws AuthRequiredError if a Bearer was provided but verification failed.
   *
   * With a mode argument: kept overloaded for forward-compat with the future `'oauth'`
   * arm. In v1 the mode argument is `'service'` and narrows the return type trivially.
   */
  resolve(): Promise<XrpcAuthResult | null>
  resolve<M extends AuthMode>(mode: M): Promise<Extract<XrpcAuthResult, { kind: M }> | null>

  /**
   * Same as resolve(), but throws on absent auth instead of returning null.
   *
   * Without a mode argument: throws AuthRequiredError if no Bearer was provided.
   * With a mode argument: in v1 behaves identically (only `'service'` is valid). When
   * the future `'oauth'` arm lands, also throws ForbiddenError if a different mode
   * authenticated than the one requested.
   */
  resolveOrFail(): Promise<XrpcAuthResult>
  resolveOrFail<M extends AuthMode>(mode: M): Promise<Extract<XrpcAuthResult, { kind: M }>>
}

class XrpcStream<L extends XrpcSubscriptionLexicon> extends Macroable {
  /** @internal — constructed by the subscription executor. */
  constructor(/* ... */) { super() /* ... */ }

  readonly aborted: boolean // shortcut for ctx.response.signal.aborted
  readonly signal: AbortSignal // for passing into downstream abortable APIs

  // Typed message builder — narrows payload to the specific ref's schema:
  message<R extends XrpcMessageRef<L>>(ref: R, payload: XrpcMessagePayload<L, R>): XrpcMessage<L>
}

class XrpcResponse<L extends XrpcLexicon> extends Macroable {
  /** @internal — constructed by the dispatcher; accessed by handlers via ctx.response. */
  constructor(/* ... */) { super() /* ... */ }

  status(code: number): this
  header(name: string, value: string): this
  body(value: XrpcResponseBody<L>): this
  redirect(url: string, status?: 301 | 302 | 303 | 307 | 308): this
}

// Handler return types — accept either the lexicon's output shape directly, or
// transformer contracts that the serializer unpacks to that shape:
type XrpcResponseBody<L> =
  | InferOutput<L>
  | ItemContract<any, any, any>
  | CollectionContract<any, any, any>
  | PaginatorContract<any, any, any>
  | Record<string, InferOutput<L> | ResourceDataTypes>
```

### Response shape (shape A)

Procedure and query handlers return the body directly. The lexicon's output schema is the type contract; the package's dispatch serializes the return value as JSON.

```ts
// Simple case — typed against InferOutput<L>
async create(ctx: XrpcContext<typeof reports.createReport>) {
  return { id: 'xyz', createdAt: new Date().toISOString() }
}

// Status / header overrides via ctx.response (Adonis HTTP idiom)
async create(ctx) {
  ctx.response.status(201).header('etag', '...')
  return { id: 'xyz', createdAt: new Date().toISOString() }
}

// Explicit body() — useful when continuing post-response work
async create(ctx) {
  const report = await Report.create({ /* ... */ })
  ctx.response.body({ id: report.id })
  setImmediate(() => moderationQueue.add({ reportId: report.id }))
  await notifyAdmins(report)
}

// Redirect (com.atproto.sync.getBlob pattern)
async getBlob(ctx) {
  const blob = await Blob.findOrFail(ctx.params.cid)
  return ctx.response.redirect(blob.cdnUrl, 302)
}

// Error — throw, never return
async create(ctx) {
  throw new InvalidRequestError('reasonType not recognized')
}
```

If `body()` was called AND a value was returned, `body()` wins (Adonis convention: explicit beats implicit). The package logs a warning when both happen.

### Subscription handler shape

Subscription handlers are async generators yielding messages built via `ctx.response.message(ref, payload)`. (For subscription lexicons, `ctx.response` is typed as `XrpcStream<L>` — see _XrpcContext shape_.) The builder constructs a properly-typed message object with the `$type` discriminator automatically derived from the lexicon's NSID plus the ref name, and narrows the `payload` argument to the specific ref's schema.

```ts
async *subscribe(ctx: XrpcContext<typeof labels.subscribeLabels>) {
  if (ctx.params.cursor !== undefined) {
    const current = await labelStore.currentSeq()
    if (ctx.params.cursor > current) {
      throw new FutureCursorError('cursor is from the future')
    }
  }

  for await (const label of labelStore.iterFromCursor(ctx.params.cursor, ctx.response.signal)) {
    if (ctx.response.aborted) return

    yield ctx.response.message('#labels', {
      seq: label.seq,
      labels: LabelTransformer.transform(label.labels),  // Collection contract — auto-unpacked
    })
  }
}
```

The lifecycle semantics map directly to language primitives:

- **yield** = send a message frame
- **return** = close the stream normally
- **throw `XrpcError`** = encode an error frame matching the lexicon's `errors[]` (by `name`), then close
- **`ctx.response.signal.aborted`** = the client disconnected — generator should return to terminate cleanly

The package wraps the user generator with a transforming generator that pipes each yielded value through `xrpcSerializer.serializeWithoutWrapping(...)` for transformer-contract unpacking before atcute's framing layer encodes to CBOR.

## Configuration

```ts
// consumer: config/atproto_xrpc.ts
import { defineConfig } from '@thisismissem/adonisjs-atproto-xrpc'
import {
  CompositeDidDocumentResolver,
  AtprotoWebDidDocumentResolver,
  PlcDidDocumentResolver,
} from '@atcute/identity-resolver'
import env from '#start/env'

export default defineConfig({
  // Service DID — the audience for incoming service-JWT verification.
  serviceDid: env.get('ATPROTO_SERVICE_DID'),

  // DID document resolver — looks up issuer DIDs to verify their signing keys.
  // Consumer constructs this explicitly; package never auto-builds one.
  resolver: new CompositeDidDocumentResolver({
    methods: {
      plc: new PlcDidDocumentResolver(),
      web: new AtprotoWebDidDocumentResolver(),
    },
  }),
})
```

The provider reads this config during `register()` and uses it to construct the `ServiceJwtVerifier` instance passed into `XrpcAuth` at dispatch time. An OAuth-verifier slot will be added back when the `.oauth()` method ships in a future minor (see _Why v1 ships service-only auth_ and _Future work_).

## Kernel registrations

```ts
// start/kernel.ts
import server from '@adonisjs/core/services/server'
import xrpc from '@thisismissem/adonisjs-atproto-xrpc/services/xrpc'

server.errorHandler(() => import('#exceptions/handler'))
xrpc.errorHandler(() => import('#exceptions/handler')) // SAME factory — one class to maintain

// Optional — only register if you need subscription-specific error handling
// distinct from the regular `errorHandler`. Falls through to `errorHandler` if
// not registered, so most consumers leave this out.
// xrpc.subscriptionErrorHandler(() => import('#exceptions/subscription_handler'))
```

The first two registrations point at the same factory file. The consumer's `app/exceptions/handler.ts` extends Adonis's `HttpExceptionHandler`; the XRPC service uses only `report()` and `shouldReport()` from it, skipping `handle()` (whose content-negotiation logic doesn't apply to XRPC's fixed wire format). The third (commented-out) registration is the escape valve for consumers whose shared handler doesn't cope well with the subscription path's synthetic HttpContext — they can register a dedicated subscription-error class that handles the divergence explicitly.

The XRPC service singleton (`@thisismissem/adonisjs-atproto-xrpc/services/xrpc`) mirrors `@adonisjs/core/services/server` in shape — six lines:

```ts
import app from '@adonisjs/core/services/app'
let xrpc
await app.booted(async () => {
  xrpc = await app.container.make('xrpc')
})
export { xrpc as default }
```

The provider binds `'xrpc'` to an `XrpcService` instance — the consumer-facing facade. `XrpcService` is the public API; `XrpcServer` (described above) is the internal dispatch orchestrator and never imported by consumers.

```ts
class XrpcService {
  #app: ApplicationService
  #errorHandlerFactory?: LazyImport<XrpcExceptionHandler>
  #resolvedErrorHandler?: XrpcExceptionHandler // memoized after first resolution
  #subscriptionErrorHandlerFactory?: LazyImport<XrpcExceptionHandler>
  #resolvedSubscriptionErrorHandler?: XrpcExceptionHandler // memoized

  constructor(app: ApplicationService) {
    this.#app = app
  }

  /**
   * Programmatic access to the routes builder — the same `XrpcRouter`
   * instance that `router.xrpc` resolves to. The provider stashes the reference
   * onto the service at boot time (after constructing it via the macroable
   * getter), so this read is synchronous from the consumer's perspective.
   * Useful for tests, or for consumers that register routes outside
   * `start/routes.ts` (e.g., from a plugin).
   */
  get routes(): XrpcRouter {
    /* returns the stashed reference */
  }

  /**
   * Register the XRPC exception handler factory. Called from kernel.ts during
   * preload — the factory itself is invoked lazily on first error. Used for
   * procedure / query errors, and as the fallback for subscription errors when
   * no dedicated subscription handler is registered.
   */
  errorHandler(factory: LazyImport<XrpcExceptionHandler>): this {
    this.#errorHandlerFactory = factory
    return this
  }

  /**
   * Register a dedicated subscription-error handler factory. Optional — when not
   * registered, subscription errors fall through to the regular `errorHandler`.
   * Use this when the synthetic HttpContext's lack of middleware-populated state
   * (session, cookies, etc.) creates edge cases in your shared handler, or when
   * you want subscription-specific tagging / reporting separate from the
   * HTTP-side handler.
   *
   * The factory shape is the same as `errorHandler`'s — instances need `report()`
   * and `shouldReport()`. Consumers commonly use the same class for both paths;
   * a separate factory is the escape valve when the paths' contexts diverge.
   */
  subscriptionErrorHandler(factory: LazyImport<XrpcExceptionHandler>): this {
    this.#subscriptionErrorHandlerFactory = factory
    return this
  }

  /**
   * Resolve and memoize the registered exception handler. Called by the
   * shared executor function when an error needs to be reported. Returns null
   * if no factory was registered (e.g., tests, or consumers who don't want
   * XRPC-specific error handling).
   *
   * @internal
   */
  async getRegisteredErrorHandler(): Promise<XrpcExceptionHandler | null> {
    if (this.#resolvedErrorHandler) return this.#resolvedErrorHandler
    if (!this.#errorHandlerFactory) return null
    const mod = await this.#errorHandlerFactory()
    this.#resolvedErrorHandler = await this.#app.container.make(mod.default)
    return this.#resolvedErrorHandler
  }

  /**
   * Resolve and memoize the subscription-error handler if one was registered,
   * otherwise fall through to the regular error handler. Called by the executor's
   * subscription dispatch branch when an error needs to be reported.
   *
   * @internal
   */
  async getRegisteredSubscriptionErrorHandler(): Promise<XrpcExceptionHandler | null> {
    if (this.#resolvedSubscriptionErrorHandler) return this.#resolvedSubscriptionErrorHandler
    if (!this.#subscriptionErrorHandlerFactory) {
      return this.getRegisteredErrorHandler() // fall through
    }
    const mod = await this.#subscriptionErrorHandlerFactory()
    this.#resolvedSubscriptionErrorHandler = await this.#app.container.make(mod.default)
    return this.#resolvedSubscriptionErrorHandler
  }
}
```

The `errorHandler(factory)` and `subscriptionErrorHandler(factory)` registrations are late-bound: `kernel.ts` runs after the package's `boot()` (kernel.ts is loaded as a preload), so the `XrpcService` instance must exist before the registration call, and the factory is held until first resolution. This is the same pattern Adonis uses for `server.errorHandler(...)` — the resolved handler is cached after first use.

The shared executor function receives the `XrpcService` instance (alongside the `RouteRegistry`, `ServiceJwtVerifier`, and `XrpcSerializer`) via the surrounding closure when `createXrpcExecutor({ ... })` constructs it during provider `boot()`. The executor calls `xrpc.getRegisteredErrorHandler()` (procedure/query path) or `xrpc.getRegisteredSubscriptionErrorHandler()` (subscription path) from inside its catch block when an error needs to be reported:

```ts
// Procedure / query catch block:
const errorHandler = await xrpc.getRegisteredErrorHandler()
await errorHandler?.report(err, httpCtx)

// Subscription catch block — falls through to the regular handler if no
// subscription-specific one was registered:
const errorHandler = await xrpc.getRegisteredSubscriptionErrorHandler()
await errorHandler?.report(err, syntheticHttpCtx)
```

There's no implicit global — the reference flows through the executor's closure-captured dependencies and the resolved-handler memoization lives on the `XrpcService` singleton.

## Container bindings — `HttpContext.xrpc`

The provider extends `HttpContext` via Adonis's Macroable mechanism so that the XRPC context is accessible from any handler that receives an HttpContext:

```ts
// in xrpc_provider.ts (register phase)
HttpContext.getter('xrpc', function () {
  return this.containerResolver.make(XrpcContext)
})

declare module '@adonisjs/core/http' {
  interface HttpContext {
    xrpc?: XrpcContext<XrpcLexicon>
  }
}
```

For HTTP-triggered XRPC errors, the XRPC dispatch middleware binds `XrpcContext` on the inherited resolver. For subscription-triggered errors, the upgrade-event listener does the same on the synthetic HttpContext's resolver. Either way, `httpCtx.xrpc` returns the `XrpcContext` whenever an XRPC error is being reported.

The consumer's `report()` method can optionally inspect `ctx.xrpc` for XRPC-specific tagging without writing two handlers. The snippet below is **illustrative consumer code** (lives in `app/exceptions/handler.ts` in a consumer app) — this package doesn't ship it; it's here only to show the shape `ctx.xrpc` enables:

```ts
// app/exceptions/handler.ts
import { ExceptionHandler, HttpContext } from '@adonisjs/core/http'
import { Sentry } from '#start/sentry'

import { isService } from '@thisismissem/adonisjs-atproto-xrpc'

export default class HttpExceptionHandler extends ExceptionHandler {
  async report(error: unknown, ctx: HttpContext) {
    // Resolve auth without throwing — we only want it for tagging, and a verification
    // failure shouldn't mask the original error we're reporting.
    const auth = await ctx.xrpc?.auth.resolve().catch(() => null)

    Sentry.captureException(error, {
      tags: {
        ...(ctx.xrpc && {
          nsid: ctx.xrpc.lexicon.id,
          method: ctx.xrpc.lexicon.defs.main.type,
        }),
      },
      // isService() is used here for forward-compat: in v1 it's trivially true on any
      // non-null XrpcAuthResult, but when the future `.oauth()` arm lands the guard
      // narrows to the service case correctly.
      user: isService(auth) ? { id: auth.service, segment: 'service' } : undefined,
    })
    return super.report(error, ctx)
  }
}
```

## HTTP-context constraint for subscriptions

Adonis's `HttpContext.getOrFail()` static accessor reads from a _private_ `AsyncLocalStorage` instance that Adonis only enters during normal HTTP request processing (when `useAsyncLocalStorage` is true in `config/app.ts`). The XRPC package cannot enter that ALS from outside.

**Consequence**: inside a subscription handler, `HttpContext.getOrFail()` will return null or throw, even though a synthetic HttpContext exists for the subscription's lifetime. Code that uses the Adonis static accessor will behave differently between HTTP-triggered and subscription-triggered paths.

**Rule for XRPC routes and code called downstream from them**: use `XrpcContext.getOrFail()` instead of `HttpContext.getOrFail()`. The package maintains its own ALS (`XrpcContext.als`), entered by the executor before invoking the handler — so `XrpcContext.getOrFail()` works in both HTTP-triggered AND subscription-triggered contexts. If downstream code needs the underlying HttpContext, read it from `XrpcContext.getOrFail().httpContext` (the instance getter).

```ts
// In any service / model / helper called downstream from an XRPC handler:
const xrpcCtx = XrpcContext.getOrFail()
xrpcCtx.logger.info('something happened')
xrpcCtx.lexicon.id // 'com.example.reports.create'

// If you specifically need the HttpContext:
const httpCtx = xrpcCtx.httpContext
// ⚠ For subscription routes this is a synthetic HttpContext — session, cookies,
// and other middleware-populated properties won't be present. Mirrored properties
// on XrpcContext (logger, containerResolver, requestId) are safe in both contexts.
```

Why not monkey-patch `HttpContext.getOrFail()` to fall through to our ALS? Because the asymmetry between HTTP-triggered and subscription-triggered execution is _real_ — the synthetic HttpContext for subscriptions lacks middleware-populated state. Hiding that boundary behind a unified accessor would surface as confusing runtime nulls later. Keeping `HttpContext.getOrFail()` strictly Adonis's domain and `XrpcContext.getOrFail()` as the XRPC-aware accessor makes the boundary explicit at the API surface.

## Transformer integration

XRPC handlers integrate with `@adonisjs/http-transformers` (re-exported via `@adonisjs/core/transformers`) through path (a) — the package's internal `XrpcSerializer` extends `BaseSerializer` with `wrap = undefined` (XRPC outputs aren't wrapped in `data` keys) and unpacks transformer contracts (`Item`/`Collection`/`Paginator`) at dispatch time via `serializeWithoutWrapping`:

```ts
// internal to the package
class XrpcSerializer extends BaseSerializer {
  wrap = undefined
  definePaginationMetaData(metaData: unknown) {
    return metaData
  }
}

// in dispatch (procedure/query path), after handler resolves:
const body = await xrpcSerializer.serializeWithoutWrapping(result, ctx.containerResolver)
return finalizeResponse({ ...ctx.response.state, body })
```

Consumer-facing usage stays clean — handlers return body-shape objects with transformer contracts embedded. The snippet below is **illustrative consumer code** (lives in a consumer's controller / transformer files) — this package doesn't ship it; it's here only to show the shape the serializer enables:

```ts
// Method in a controller class:
async list(ctx: XrpcContext<typeof reports.listReports>) {
  // listReports is a service-JWT-required route (.serviceAuth()). Passing the mode
  // to resolveOrFail() narrows the return type and asserts in one step — throws
  // AuthRequiredError if no auth at all. (In v1 the mode argument is trivially
  // `'service'`; when the future `.oauth()` arm lands, ForbiddenError fires if the
  // request authenticated via a different mode.)
  const auth = await ctx.auth.resolveOrFail('service')

  const reports = await Report.query()
    .where('audience', auth.service)
    .orderBy('createdAt', 'desc')
    .limit(ctx.params.limit ?? 50)

  return {
    cursor: reports.at(-1)?.id,
    reports: ReportsTransformer.transform(reports),  // Collection contract
  }
}

// Transformer — the model -> lexicon-shape boundary
class ReportsTransformer extends BaseTransformer<Report> {
  toObject() {
    return {
      uri: this.resource.uri,
      cid: this.resource.cid,
      reasonType: this.resource.reasonType,
      reportedAt: this.resource.createdAt.toISO(),
    }
  }
}
```

The lexicon's `InferOutput<L>` is the ground truth for response shape. For v1, handler return types are loose at the contract boundary (`XrpcResponseBody<L>` admits any transformer contract); phase-2 codegen tightens this by emitting per-route return types that match `InferOutput<L>` field-by-field via the generated abstract base class.

In v1, `XrpcSerializer` is internal-only — not re-exported from `index.ts`, no `defineConfig({ serializer })` consumer slot. The dispatch layer constructs a single instance directly via `new XrpcSerializer()`. Customization of the serializer (custom subclass via a config slot) is deferred to a future minor and is fully additive (see _Future work_). The serializer's pass-through Paginator handling matches `@adonisjs/inertia`'s `InertiaSerializer` — same `wrap = undefined` + identity `definePaginationMetaData` shape — so consumers wanting flat-shape XRPC pagination use `Transformer.transform(...)` embedded in a flat `{ cursor, <pluralized-lexicon-field>: ... }` object rather than `BaseTransformer.paginate(...)`. The package's `README.md` documents this pattern explicitly.

## Error handling

This should live in src/errors.ts and be exported for public consumption.

### `XrpcError` hierarchy

```ts
import { Exception } from '@poppinss/exception'

class XrpcError extends Exception {
  static status = 500
  static code = 'E_XRPC_ERROR' // JS-level error code (for logs)
  static errorName = 'InternalServerError' // atproto wire-format error name

  get errorName(): string {
    return (this.constructor as typeof XrpcError).errorName
  }
}

// Built-in convenience subclasses (mirror @atcute/xrpc-server standard errors):
class AuthRequiredError extends XrpcError {
  static status = 401
  static code = 'E_AUTH_REQUIRED'
  static errorName = 'AuthenticationRequired'
}
class ForbiddenError extends XrpcError {
  static status = 403
  static code = 'E_FORBIDDEN'
  static errorName = 'Forbidden'
}
class InvalidRequestError extends XrpcError {
  static status = 400
  static code = 'E_INVALID_REQUEST'
  static errorName = 'InvalidRequest'
}
class RateLimitExceededError extends XrpcError {
  static status = 429
  static code = 'E_RATE_LIMITED'
  static errorName = 'RateLimitExceeded'
}
class InternalServerError extends XrpcError {
  static status = 500
  static code = 'E_INTERNAL_ERROR'
  static errorName = 'InternalServerError'
}
class UpstreamFailureError extends XrpcError {
  static status = 502
  static code = 'E_UPSTREAM_FAILURE'
  static errorName = 'UpstreamFailure'
}
class NotEnoughResourcesError extends XrpcError {
  static status = 503
  static code = 'E_NOT_ENOUGH_RESOURCES'
  static errorName = 'NotEnoughResources'
}
class UpstreamTimeoutError extends XrpcError {
  static status = 504
  static code = 'E_UPSTREAM_TIMEOUT'
  static errorName = 'UpstreamTimeout'
}
```

Three orthogonal "name" slots:

- **`name`** (inherited from `Error`): JS class name — `'FutureCursorError'`. Used for debugging / stack traces / `instanceof` discrimination.
- **`code`**: machine-readable JS-level error code — `'E_FUTURE_CURSOR'`. Used for log filtering, Adonis error handler matching, error-recovery routing.
- **`errorName`**: atproto wire-format error category — `'FutureCursor'`. Matches the lexicon's `errors[].name`. What goes into the `error` field of the wire response.

Consumer-defined errors mirror the same pattern:

```ts
class FutureCursorError extends XrpcError {
  static status = 400
  static code = 'E_FUTURE_CURSOR'
  static errorName = 'FutureCursor' // matches lexicon's errors[].name
}
```

### Error dispatch flow

**For HTTP-triggered procedure/query**: the dispatch middleware catches errors, wraps non-`XrpcError` throws as `InternalServerError`, calls `registeredErrorHandler.report(err, httpCtx)` for observability, and renders the wire-format JSON response directly. Errors don't propagate past the XRPC dispatch boundary into Adonis's normal error pipeline — the wire format is XRPC-specific and isn't subject to content-negotiation.

```ts
try {
  return await callHandler(/* ... */)
} catch (err) {
  const xrpcError = err instanceof XrpcError ? err : new InternalServerError(/* ... */)
  await registeredErrorHandler?.report(err, httpCtx)
  return buildXrpcErrorResponse(xrpcError)
}
```

**For WebSocket-triggered subscription**: the subscription handler wrapper catches errors, calls `registeredErrorHandler.report(err, httpCtx)` (where `httpCtx` is the synthetic context built at the `'upgrade'` event), and re-throws as `XRPCSubscriptionError` for atcute's machinery to encode as an error frame and close the stream.

Both paths invoke the same `registeredErrorHandler` (the class registered via `xrpc.errorHandler(() => import('#exceptions/handler'))`), passing an HttpContext — real for HTTP-triggered, synthetic for subscriptions. The consumer's `report()` method is identical for both cases.

## Codegen (v1 phase 2)

v1 ships in two phases:

**Phase 1 (initial release)**: `XrpcContext<L>` carries an optional generic. Controller-reference handlers explicitly annotate as `XrpcContext<typeof lex>` to get input/params typing. Inline handlers get full inference automatically.

**Phase 2 (follow-up)**: `indexXrpc()` hook ships, integrated into AdonisJS's `hooks.init` mechanism. The hook reads the registered XRPC routes at app-init time (after preloads, including `start/routes.ts`, have populated the package's internal registry) and emits abstract base classes in `.adonisjs/types/xrpc/controllers.d.ts`. Controller-reference handlers extend the generated base, gaining typed `XrpcContext<L>` method signatures without explicit annotation:

```ts
// adonisrc.ts (consumer)
import { indexXrpc } from '@thisismissem/adonisjs-atproto-xrpc/hooks'

export default defineConfig({
  hooks: {
    init: [
      indexEntities({
        /* ... */
      }),
      indexPages({ framework: 'react' }),
      generateRegistry(), // Tuyau
      indexXrpc(), // <-- this package, phase 2
    ],
  },
})

// Generated (gitignored):
// .adonisjs/types/xrpc/controllers.d.ts
export declare abstract class ReportsLexicon {
  abstract create(
    ctx: XrpcContext<typeof reports.createReport>
  ): Promise<XrpcResponseBody<typeof reports.createReport>>
  abstract resolve(
    ctx: XrpcContext<typeof reports.resolveReport>
  ): Promise<XrpcResponseBody<typeof reports.resolveReport>>
}

// app/controllers/reports_controller.ts (consumer)
import { ReportsLexicon } from '#xrpc/controllers'

export default class ReportsController extends ReportsLexicon {
  async create(ctx) {
    // no annotation needed
    const { reasonType, subject } = ctx.input // typed from extended base
    return { id: '...' }
  }
}
```

**Naming convention**: for a consumer controller class `<Name>Controller`, the generated abstract base is `<Name>Lexicon` (strip the `Controller` suffix, append `Lexicon`). So `ReportsController` extends `ReportsLexicon`, `LabelsController` extends `LabelsLexicon`, etc. This mirrors AdonisJS's own `User` model vs `UserSchema` (migration table schema) — the suffix flags "this is the typed contract / shape the runtime class is bound to."

The phase 2 transition is **non-breaking**: the optional generic stays in the type definition forever; what changes is whether consumers explicitly pass it. Inline handlers work identically in both phases.

The codegen uses runtime route-registry inspection rather than static analysis of `start/routes.ts`, so dynamic registration (loops, helpers, conditionals) is supported.

## Testing

### `XrpcContextFactory` (test-facing)

Tests construct contexts via `XrpcContextFactory`, paralleling Adonis's `HttpContextFactory`. Exported from `@thisismissem/adonisjs-atproto-xrpc/factories/http`. The factory carries sensible defaults for every field — tests merge only the fields that matter for the assertion:

```ts
class XrpcContextFactory {
  merge(
    params: Partial<{
      httpCtx: HttpContext // default: new HttpContextFactory().create()
      lexicon: XrpcLexicon // required — no sensible default
      request: Request // default: synthesized from lexicon NSID + method
      input: unknown // default: undefined
      params: Record<string, any> // default: {}
      signal: AbortSignal // default: never-aborts AbortSignal
      auth: XrpcAuthResult | null // default: null (treated as public / no auth)
    }>
  ): this

  create<L extends XrpcLexicon>(): XrpcContext<L>
}
```

```ts
import { XrpcContextFactory } from '@thisismissem/adonisjs-atproto-xrpc/factories/http'
import { fyi } from '#lexicons'

test('reports.create handler creates a report and returns the id', async ({ app }) => {
  const ctx = new XrpcContextFactory()
    .merge({
      lexicon: fyi.questionable.reports.create,
      input: { reasonType: 'spam', subject: { uri: 'at://...', cid: '...' } },
      // Supply the pre-resolved auth result directly (the factory bypasses the
      // verifier path when given a concrete XrpcAuthResult):
      auth: {
        kind: 'service',
        service: 'did:plc:abc',
        claims: { iss: 'did:plc:abc', aud: SERVICE_DID, lxm: NSID /* ... */ },
      },
    })
    .create<typeof fyi.questionable.reports.create>()

  const controller = await app.container.make(ReportsController)
  const result = await controller.create(ctx)

  assert.equal(result.id, '...')
})
```

`XrpcContext` is constructed with the merged params plus defaults applied. `logger` / `containerResolver` / `requestId` come from the `httpCtx` (which defaults to a fresh `HttpContextFactory().create()` if not supplied).

The factory replaces what would otherwise be a service-side `xrpc.createContext()` method — the dispatcher constructs `XrpcContext` directly at runtime (it has all the real values from the request), and tests use the factory's defaults. No middle layer needed.

### Subscription testing

Subscription handlers can be tested as plain async generators by constructing an `XrpcContext` with a stream signal:

```ts
test('subscribeLabels yields backfill events from cursor', async ({ app }) => {
  const abortController = new AbortController()

  const ctx = new XrpcContextFactory()
    .merge({
      lexicon: labels.subscribeLabels,
      params: { cursor: 100 },
      signal: abortController.signal,
    })
    .create<typeof labels.subscribeLabels>()

  const controller = await app.container.make(LabelsController)
  const generator = controller.subscribe(ctx)

  const first = await generator.next()
  assert.equal(first.value.$type, 'com.atproto.label.subscribeLabels#labels')
  assert.equal(first.value.seq, 101)

  abortController.abort()
  // ... assert generator returns ...
})
```

Functional tests of the WebSocket transport itself (real HTTP server, real upgrade) build on the patterns the labeler already uses (per memory: "Functional tests use real HTTP, not request injection").

## Commands

The package ships two ace commands, both registered automatically via the package's provider — consumers don't need to add anything to `adonisrc.ts#commands`.

### `list:xrpc:routes`

Lists every XRPC endpoint registered against `router.xrpc`. Extends Adonis's built-in `list:routes` family (`list:routes` covers HTTP; `list:xrpc:routes` covers XRPC). Useful for debugging route-registration issues, confirming a controller refactor didn't drop endpoints, or sanity-checking what a freshly-installed consumer package added.

```bash
node ace list:xrpc:routes              # human-readable table (default)
node ace list:xrpc:routes --json       # machine-readable JSON
```

Default output is a table grouped by method type (`procedure` / `query` / `subscription`), with columns for NSID, handler (controller class + method, or `<inline>`), and auth declaration (`public` / `service` / `service?` for optional). The command reads from `router.xrpc.operations` after the commit phase, so it requires the app to have booted through `ready()`.

The `--json` flag mirrors Adonis's `list:routes --json` convention. Output shape is a flat array of route descriptors, one per registered endpoint — suitable for `jq` pipelines, scripts, or LLM-driven tooling (Claude Code agents, etc.) that need to introspect registered routes without scraping a human-formatted table:

```json
[
  {
    "nsid": "fyi.questionable.reports.create",
    "type": "procedure",
    "handler": { "controller": "ReportsController", "method": "create" },
    "auth": { "serviceAuth": true, "optional": false }
  },
  {
    "nsid": "com.atproto.label.subscribeLabels",
    "type": "subscription",
    "handler": "<inline>",
    "auth": { "serviceAuth": false, "optional": false }
  }
]
```

Field stability: this JSON shape is part of the package's public contract — additive changes (new fields) are non-breaking; renames or removals would ship as a major version bump.

Implementation lives in `commands/list_xrpc_routes.ts`. The command class extends `BaseCommand` from `@adonisjs/core/ace`, depends on the `XrpcService` (resolved via the container) for the routes accessor, declares the `--json` boolean flag, and uses Adonis's `ui` helper for table rendering when the flag is absent or `JSON.stringify(routes, null, 2)` when present.

### `make:xrpc:controller`

Scaffolds an XRPC controller class. Extends Adonis's `make:controller` family (`make:controller` for plain HTTP controllers; `make:xrpc:controller` for XRPC).

```bash
node ace make:xrpc:controller reports
# generates app/controllers/reports_controller.ts
```

The generated file is a minimal template — `import { XrpcContext } from '@thisismissem/adonisjs-atproto-xrpc'`, an exported class, no pre-populated methods. The consumer adds handlers matching the lexicons they're registering. (When phase-2 codegen has run via `indexXrpc()`, consumers can manually swap the import to `extends ReportsLexicon` for the typed-base experience — the scaffolding doesn't try to detect the codegen state, keeping the template simple.)

Implementation lives in `commands/make_xrpc_controller.ts`. Uses Adonis's codemod utility (`@adonisjs/core/ace/codemods`) to generate the file with the standard naming convention (snake_case file → PascalCase class with `Controller` suffix).

## Migration: existing `subscribeLabels` handler

_Illustrative example of consumer use — the actual migration is work in the `adonisjs-atproto-labeler` repository, done after this package ships. Included here to validate that the framework primitives cover the existing handler's needs._

Current shape in `adonisjs-atproto-labeler/providers/provider.ts:78-98`:

```ts
router.addSubscription(ComAtprotoLabelSubscribeLabels, {
  async *handler({ params, signal }) {
    try {
      for await (const event of labeler.subscribeLabels({ cursor: params.cursor, signal })) {
        yield {
          $type: 'com.atproto.label.subscribeLabels#labels',
          ...event,
        }
      }
    } catch (err) {
      if (err instanceof FutureCursorError) {
        throw new XRPCSubscriptionError({ error: 'FutureCursor' })
      }
      throw err
    }
  },
})
```

Post-migration:

```ts
// start/routes.ts (consumer)
import router from '@adonisjs/core/services/router'

router.xrpc.subscription(labels.subscribeLabels, [LabelsController, 'subscribe'])

// errors.ts (in the labeler package)
import { XrpcError } from '@thisismissem/adonisjs-atproto-xrpc'
import { FutureCursorError as AtcuteFutureCursorError } from '@atcute/labeler'

// Consumer-defined XRPC error subclass — its errorName matches the lexicon's
// declared #FutureCursor error so the dispatcher renders the right wire frame:
export class FutureCursorError extends XrpcError {
  static status = 400
  static errorName = 'FutureCursor'

  static from(err: AtcuteFutureCursorError): FutureCursorError {
    return new FutureCursorError(err.message, { cause: err })
  }
}

// app/controllers/labels_controller.ts (in the labeler package)
import { inject } from '@adonisjs/core'
import { Labeler, FutureCursorError as AtcuteFutureCursorError } from '@atcute/labeler'
import { FutureCursorError } from '#labeler/errors'

@inject()
export default class LabelsController {
  constructor(protected labeler: Labeler) {}

  async *subscribe(ctx: XrpcContext<typeof labels.subscribeLabels>) {
    try {
      for await (const event of this.labeler.subscribeLabels({
        cursor: ctx.params.cursor,
        signal: ctx.response.signal,
      })) {
        if (ctx.response.aborted) return
        yield ctx.response.message('#labels', event)
      }
    } catch (err) {
      // Caller does the instanceof check; FutureCursorError.from is a pure
      // typed constructor that propagates `err` via Error.cause.
      if (err instanceof AtcuteFutureCursorError) {
        throw FutureCursorError.from(err)
      }
      throw err
    }
  }
}
```

The migration changes:

- The spread-with-`$type` dance is replaced by `ctx.response.message('#labels', event)`, which type-checks the payload against the ref's schema exactly. (For subscription lexicons, `ctx.response` is typed as `XrpcStream<L>` — see _XrpcContext shape_.)
- The previous catch-and-rethrow (which built `XRPCSubscriptionError` inline) is replaced by an `instanceof` check in the controller plus `FutureCursorError.from(err)` — a typed static constructor on the consumer-defined XrpcError subclass. The original atcute error is attached via the standard ES2022 `Error.cause` mechanism, preserving the upstream stack for debugging and error reporters.

The labeler's `subscribeLabels` method (the underlying `@atcute/labeler` API) is unchanged — only the registration shape, the wrapping layer, and the error-translation shape change.

## Open implementation details

These can be settled during writing-plans / implementation; they don't affect the architectural surface.

### Provider boot ordering for the labeler refactor

The labeler-package's provider needs `router.xrpc` available at its own boot — meaning the XRPC package's provider must run first. AdonisJS provider ordering can be controlled via the `aliases` field or by registration order in `adonisrc.ts`. Verify during the labeler migration.

### CORS configuration interaction

AdonisJS CORS is configured globally via `config/cors.ts` — there's no per-route CORS configuration in Adonis (the middleware runs before this package's dispatch middleware in `server.use([...])`, applying its config to every request). XRPC clients may need allowed headers and origins that differ from the rest of the application; if a consumer needs path-conditional logic, the `origin` and `headers` fields accept callback forms that receive `(value, ctx)` and can inspect `ctx.request.url()` to branch on `/xrpc/*` paths. The `methods` field is static-array-only, but XRPC only uses GET and POST, so this isn't a practical limitation. Document a starter `config/cors.ts` snippet in the README — including the canonical atproto request headers (`atproto-accept-labelers`, `atproto-proxy`, `atproto-content-labelers`) in `allowedHeaders`.

### TypeScript inference for handlers

The signature `procedure<L>(lexicon: L, handler: ...)` relies on TypeScript inferring `L` from the lexicon argument. For inline handlers this works directly. For controller-reference handlers, the `GetXrpcControllerHandlers<Controller, L>` mapped-conditional type (defined in the Public-exports section; similar in spirit to Adonis's own controller-method-name inference) narrows the second tuple element to the controller's methods whose first parameter is `XrpcContext<L>`. Verify the inference at implementation time — TypeScript's inference is sensitive to where conditional types fire and how the tuple positions resolve, so the lexicon argument must be inferred before the controller's method type is checked. Phase-2 codegen (`indexXrpc()`) sidesteps this entirely by emitting abstract base classes whose method signatures are concrete at codegen time.

### Request ID generation for subscriptions

`HttpRequest.id()` returns the value from the `x-request-id` header — `string | undefined`. AdonisJS additionally has `generateRequestId: boolean` in `config/app.ts` which auto-generates an ID when the header is missing. For HTTP-triggered XRPC routes this works as normal because the HttpContext is constructed by Adonis's pipeline (which respects the config).

For subscriptions, the synthetic HttpContext is constructed manually by the package at the `'upgrade'` event. The package mirrors HTTP-side behavior exactly: (1) read `x-request-id` from the upgrade request's headers (the upgrade is a real HTTP request — clients can send the header); (2) if absent, honor `config/app.ts#generateRequestId` — generate when true, leave undefined when false. This keeps subscription request-ID behavior consistent with HTTP routes for the same Adonis config knob, avoiding the surprise of "I turned off generateRequestId but subscriptions still get IDs." Consumers who want guaranteed correlation set the knob to true at the config level and it applies everywhere.

## Future work

Items the package might grow into post-v1:

- **OAuth verification — `.oauth()` sibling method**: the canonical "when does `.oauth()` come back" entry. AT Protocol OAuth tokens are opaque, so server-side verification requires introspection (or similar) — a pattern that hasn't been established across the ecosystem yet, and that neither `@atproto/bsky`'s nor `@atproto/ozone`'s `AuthVerifier` implements (both lean on service JWTs; bsky adds a `@NOTE temporarily` entryway-session-token stopgap). When either (a) `@atcute/*` ships a server-side verifier for opaque tokens that this package can wire up, or (b) the ecosystem settles on an introspection contract consumers can implement themselves, this package adds an `.oauth(options?)` method symmetric with `.serviceAuth()`. The `XrpcAuthResult` discriminated union grows a `{ kind: 'oauth'; ... }` arm. `defineConfig` regains an `oauthVerifier` slot. Forward-compat is intentional: nothing about the v1 surface needs to change-in-place to get there — only additions. See _Why v1 ships service-only auth_ in the Authentication section for the deeper background.

- **Lexicon-driven auth declarations** — switch (or supplement) the builder-based `.serviceAuth()` / `.oauth()` calls with auth modes derived from the lexicon spec. This is gated on _three_ independent changes:
  - **Protocol-level**: the atproto Lexicon spec needs to grow expressive enough to distinguish auth modes in per-method declarations. The current `auth: 'standard' | 'optional' | absent` field treats "authenticated" as a single category. The [XRPC spec](https://atproto.com/specs/xrpc) lists per-mode auth declarations as future work; until they're spec'd, no downstream change can expose what the lexicon doesn't carry.
  - **atcute-level**: once the lexicon spec ships, atcute needs to expose the new field on its runtime metadata. [`mary-ext/atcute#76`](https://github.com/mary-ext/atcute/issues/76) is the placeholder issue for that follow-up exposure.
  - **OAuth verifier**: even with lexicon-declared auth, routes declaring OAuth need a runnable verifier — same dependency as the `.oauth()` method above.

  Implication for this package: the builder calls are load-bearing for the foreseeable future, not just until atcute#76 closes. When all three gates eventually fall, the migration is non-breaking — lexicon-declared auth takes precedence where the lexicon expresses it; explicit `.serviceAuth()` / `.oauth()` calls continue to work for any route whose lexicon doesn't (yet) declare its auth contract.

- **Rate-limit middleware integration** — `@adonisjs/limiter` interop, per-route limits via a `.rateLimit(...)` chained method on the `XrpcRoute` builder (likely registered via `XrpcRoute.macro(...)` from the integration package itself, rather than shipping in this package directly) or via the `XrpcRouteGroup` handle for group-wide limits.

- **Strict-mode auth declarations** — opt-in `defineConfig({ requireExplicitAuth: true })` flag that makes any route declaring neither `.serviceAuth()` nor an explicit `.public()` throw at `commit()`. Use case: Ozone-style services where most routes are authenticated and a missing declaration is more likely a forgotten `.serviceAuth()` than an intentionally-public route. The default stays public (aligning with the Lexicon spec's `auth: absent` default); strict-mode is a per-consumer audit-style affordance, not a posture flip.

- **Custom serializer extension via `defineConfig({ serializer })`** — let consumers supply their own `XrpcSerializer` subclass to customize wrap keys, pagination metadata transformation, or contract-handling behavior. v1 ships the serializer as internal-only (`XrpcSerializer` constructed directly by the dispatch layer, not re-exported from `index.ts`) because no consumer use case has surfaced — the default pass-through serializer matches `@adonisjs/inertia`'s precedent and covers the canonical atproto pagination shape without customization. When a real need appears, the migration is purely additive: re-export `XrpcSerializer` from the package root, add a `serializer?: typeof XrpcSerializer` field to `XrpcConfig`, default to `XrpcSerializer` in `defineConfig`, and change the dispatch construction site from `new XrpcSerializer()` to `new config.serializer()`. Non-breaking in every direction.

## Related work

- `docs/specs/2026-05-17-adonisjs-atproto-xrpc-design.md` — superseded by this document; preserved for traceability.
- `@thisismissem/adonisjs-atproto-labeler` — the existing labeler package; first consumer of this one.
- `@atcute/xrpc-server` — the underlying XRPC routing library this package wraps.
- `@atcute/xrpc-server-node` — the Node-specific WebSocket adapter (creates `wss`, hooks `'upgrade'`, handles connection lifecycle).
- `@atcute/xrpc-server/auth` — service-JWT verification primitives.
- `@adonisjs/http-transformers` — the transformer / serializer primitives this package's `XrpcSerializer` extends.
- `@poppinss/exception` — the base class for `XrpcError`.
