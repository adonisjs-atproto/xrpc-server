# `@thisismissem/adonisjs-atproto-xrpc` package — design (superseded)

> **Superseded by [`2026-05-21-adonisjs-atproto-xrpc-design.md`](./2026-05-21-adonisjs-atproto-xrpc-design.md).** This document is kept for traceability. The 2026-05-21 spec reshapes the auth declaration surface — `router.xrpc.authenticated()` is replaced by general-purpose grouping (`router.xrpc.group()`) plus per-route `.auth(mode, options?)` declarations, the auth taxonomy expands from "service JWT only" to a stacking model covering OAuth + service JWT independently, and the atcute#76 framing is corrected to reflect a protocol-level lexicon-spec gap rather than just an atcute exposure gap. Refer to the 2026-05-21 spec for the canonical design.

**Status:** Superseded by `2026-05-21-adonisjs-atproto-xrpc-design.md`.
**Date:** 2026-05-19
**Subject:** `@thisismissem/adonisjs-atproto-xrpc` (now in its own repository; scaffolding exists, implementation pending)

## Summary

An AdonisJS v7+ package that bridges AdonisJS's HTTP/router conventions to AT Protocol XRPC server-side dispatch, wrapping [`@atcute/xrpc-server`](https://www.npmjs.com/package/@atcute/xrpc-server) and its Node WebSocket adapter (`@atcute/xrpc-server-node`).

The consumer-facing surface is `router.xrpc.{procedure, query, subscription}` for declaring routes plus `router.xrpc.authenticated(() => ...)` for declaring service-JWT-protected groups. Each handler receives an `XrpcContext<L>` typed against the registered lexicon. HTTP-side dispatch runs as server-level middleware mounted in `start/kernel.ts`'s `server.use([...])` chain; WebSocket subscription dispatch hooks the Node server's `'upgrade'` event via the atcute adapter, with both paths sharing a single registered `XRPCRouter` instance.

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
│   ├── xrpc.ts             — service singleton (analog to @adonisjs/core/services/server); exposes errorHandler() + createContext()
│   └── router.ts           — singleton accessor for the XRPCRouter
├── hooks/
│   └── generate_controllers.ts  — codegen hook for hooks.init (v1 phase 2)
├── src/
│   ├── define_config.ts    — defineConfig + XrpcConfig typing
│   ├── builder.ts          — XrpcRouterBuilder class (the router.xrpc surface)
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
  XrpcRouterBuilder,
  XrpcLexicon,
  InferInput,
  InferParams,
  InferOutput,
  XrpcMessage,
} from './src/types.js'
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
export { generateXrpcControllers } from './hooks/generate_controllers.js'
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

`XrpcRouterBuilder` exposes the typed declaration API. The handler shapes mirror Adonis's own router types (`get` / `post` / etc.) — accepting either an inline function or a `[Controller | LazyImport<Controller>, methodName?]` tuple, with a `GetXrpcControllerHandlers` helper that narrows method names to those accepting `XrpcContext<L>` as the first parameter:

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

class XrpcRouterBuilder {
  constructor(private app: ApplicationService) {}

  procedure<L extends XrpcProcedureLexicon, T extends Constructor<any>>(
    lexicon: L,
    handler: XrpcRouteFn<L> | [LazyImport<T> | T, GetXrpcControllerHandlers<T, L>?]
  ): void

  query<L extends XrpcQueryLexicon, T extends Constructor<any>>(
    lexicon: L,
    handler: XrpcRouteFn<L> | [LazyImport<T> | T, GetXrpcControllerHandlers<T, L>?]
  ): void

  subscription<L extends XrpcSubscriptionLexicon, T extends Constructor<any>>(
    lexicon: L,
    handler: XrpcSubscriptionFn<L> | [LazyImport<T> | T, GetXrpcControllerHandlers<T, L>?]
  ): void

  // Authenticated-group callback: registrations inside the callback are tagged
  // with a service-JWT verification requirement before being added to the
  // underlying XRPCRouter.
  authenticated(callback: () => void): void
}
```

The `LazyImport<T>` shape (`() => Promise<{ default: T }>`) lets consumers defer controller loading until first use — same pattern Adonis's router supports for `[() => import('#controllers/foo'), 'index']`. This isn't only an ergonomic choice for boot-time deferral: it's also what enables **hot reloading** of controller code in development. Adonis's HMR system invalidates the LazyImport callback's resolved module when the underlying controller file changes, so the next XRPC request re-imports the fresh module. Eager class references (e.g., `[ReportsController, 'create']` where `ReportsController` is imported at the top of `routes.ts`) bypass HMR — the route holds a permanent reference to the originally-imported class. Consumers should prefer the `LazyImport` form for any controller they want to iterate on without restarting the dev server.

The optional second tuple element (the method name) is type-narrowed by `GetXrpcControllerHandlers<T, L>` so consumers get autocomplete + compile-time errors when naming a method that doesn't accept the right `XrpcContext<L>` shape. If omitted, the package falls back to a convention (likely `handle`, matching Adonis's default).

Registration is **closure-deduplicated**: rather than create N wrapper closures (one per registered route, each capturing `lexicon` / `handler` / `authenticated` in its lexical scope), the package maintains a shared `RouteRegistry` (`Map<string, RouteInfo>` indexed by NSID) and registers a single shared **executor function** with atcute for every route. This matters at scale: a service hosting `com.atproto.*` + `app.bsky.*` lexicons easily reaches 100-200+ registered handlers (verified: `com.atproto.*` ships 86 XRPC methods in `@atcute/atproto`; `app.bsky.*` has 71+ in published Bluesky lexicons), and per-route closures would each retain references to their full captured scope — meaningful memory pressure that scales linearly.

The package separates **route declaration** (builder) from **route execution** (executor) into distinct units — same shape AdonisJS's HTTP router uses ([adonisjs/http-server `executor.ts`](https://github.com/adonisjs/http-server/blob/8.x/src/router/executor.ts)). The builder is class-based (stateful, accumulates declarations into its own internal routes map); the executor is a pure function (stateless per-request dispatch). `commitRoutes` is a free function that wires the two together at the boundary between phases.

```ts
// Method type is derived from lexicon.type ('xrpc_query' / 'xrpc_procedure' / 'xrpc_subscription')
// rather than stored separately — the lexicon metadata already carries the discriminator atcute uses
// internally (see XRPCRouter.add's switch in @atcute/xrpc-server).
type RouteAuthMode = 'none' | 'required' | 'optional'

interface RouteInfo {
  lexicon: XrpcLexicon
  handler:
    | XrpcRouteFn<any>
    | XrpcSubscriptionFn<any>
    | [LazyImport<any> | Constructor<any>, string?]
  authMode: RouteAuthMode
}

/**
 * Build-time: accumulates route declarations and owns the routes map.
 * Doesn't know about the underlying XRPCRouter or the executor — both are
 * "lifted up" to the provider, which orchestrates commit independently.
 *
 * The routes map lives on the builder rather than a separate registry class —
 * the registry was over-encapsulation for a 100-line class. Read accessors
 * (`find`, `values`, `frozen`) cover the cases the executor and commitRoutes
 * need to reach in for; the rest stays private.
 */
class XrpcRouterBuilder {
  #operations = new Map<string, RouteInfo>()
  #committed = false
  #currentAuthMode: RouteAuthMode = 'none'

  // === Public registration API (called from start/routes.ts) ===

  /**
   * Declares an auth-protected route group. Default is required auth; pass
   * `{ optional: true }` for optional auth (verify if Bearer token present;
   * proceed unauthenticated otherwise; throw on present-but-invalid).
   */
  authenticated(callback: () => void, options?: { optional?: boolean }): void {
    if (this.#committed) throw new RuntimeException('Cannot declare XRPC auth groups after commit')
    const prev = this.#currentAuthMode
    this.#currentAuthMode = options?.optional ? 'optional' : 'required'
    try {
      callback()
    } finally {
      this.#currentAuthMode = prev
    }
  }

  procedure<L extends XrpcProcedureLexicon, T extends Constructor<any>>(
    lexicon: L,
    handler: XrpcRouteFn<L> | [LazyImport<T> | T, GetXrpcControllerHandlers<T, L>?],
  ): void {
    if (this.#committed) throw new RuntimeException('Cannot register XRPC routes after commit')
    this.#operations.set(lexicon.id, { lexicon, handler, authMode: this.#currentAuthMode })
  }

  query<L extends XrpcQueryLexicon, T extends Constructor<any>>(
    lexicon: L,
    handler: XrpcRouteFn<L> | [LazyImport<T> | T, GetXrpcControllerHandlers<T, L>?],
  ): void {
    if (this.#committed) throw new RuntimeException('Cannot register XRPC routes after commit')
    this.#operations.set(lexicon.id, { lexicon, handler, authMode: this.#currentAuthMode })
  }

  subscription<L extends XrpcSubscriptionLexicon, T extends Constructor<any>>(
    lexicon: L,
    handler: XrpcSubscriptionFn<L> | [LazyImport<T> | T, GetXrpcControllerHandlers<T, L>?],
  ): void {
    if (this.#committed) throw new RuntimeException('Cannot register XRPC routes after commit')
    this.#operations.set(lexicon.id, { lexicon, handler, authMode: this.#currentAuthMode })
  }

  /** True after commit. */
  get committed(): boolean {
    return this.#committed
  }

  get operations(): Record<string, RouteInfo> {
    // TODO: double check syntax
    return Object.fromEntries(this.#operations.entries())
  }

  commit(): boolean {
    if (this.#committed) // raise error
    this.#committed = true
  }
}

// Separate file: These code below here is separate from the router:

/**
 * Commit orchestration: a free function, not a method on the builder.
 * Called by the provider's ready() hook after preloads have populated the
 * builder's route map.
 *
 * Freezes the builder FIRST (so the "no more writes" invariant holds
 * regardless of what happens during the wiring loop), then iterates the
 * frozen-but-still-readable routes to wire each one into atcute's XRPCRouter
 * with the shared executor.
 *
 * Idempotent: `builder.freeze()` returns false on subsequent calls and we
 * short-circuit — no risk of duplicate addProcedure/addQuery/addSubscription
 * calls into atcute if commit is somehow invoked twice.
 *
 * Same boundary AdonisJS's router.commit() establishes — "routes declared"
 * vs "routes active" — but as a free function rather than a method, so the
 * builder doesn't need to hold references to the XRPCRouter or executor.
 */
// FIXME: This isn't correct
function commitRoutes(
  builder: XrpcRouterBuilder,
  xrpcRouter: XRPCRouter,
  executor: SharedXrpcExecutor,
): void {
  if (!builder.committed) return  // already committed; skip wiring

  for (const route of builder.values()) {
    switch (route.lexicon.type) {
      case 'xrpc_procedure':
        xrpcRouter.addProcedure(route.lexicon, { handler: executor })
        break
      case 'xrpc_query':
        xrpcRouter.addQuery(route.lexicon, { handler: executor })
        break
      case 'xrpc_subscription':
        xrpcRouter.addSubscription(route.lexicon, { handler: executor })
        break
    }
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

    // Auth: construct an XrpcAuth holding the verifier closure (or null if the
    // route has no auth). Verification runs lazily on first accessor call.
    // For required-auth routes we pre-trigger after the context is built to
    // preserve fail-fast semantics.
    const auth = new XrpcAuth(
      atcuteCtx.request,
      route.lexicon,
      route.authMode === 'none' ? null : serviceJwtVerifier,
    )

    const xrpcCtx = await xrpc.createContext({
      httpCtx,
      lexicon: route.lexicon,
      request: atcuteCtx.request,
      input: 'input' in atcuteCtx ? atcuteCtx.input : undefined,
      params: atcuteCtx.params,
      signal: atcuteCtx.signal,
      auth,
    })
    httpCtx.containerResolver.bindValue(XrpcContext, xrpcCtx)

    // I suspect this can be moved into executor, so we create an executor for the specific route handler, and register that with xrpcRouter
    if (route.authMode === 'required') {
      await auth.getUserOrFail() // throws AuthRequiredError; caught by outer try/catch
    }

    const handler = isControllerRef(route.handler)
      ? await resolveControllerMethod(httpCtx.containerResolver, route.handler)
      : route.handler

    // This is execution logic, not setting up the stage for the executor:
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
  }
}
}
```

The user's handler signature stays `(ctx: XrpcContext<typeof reports.createReport>) => ...` — TypeScript still type-checks that. The executor operates on `XrpcContext<any>` (broad runtime view); when it invokes the user's handler, TypeScript's structural typing accepts the cast because the registered handler's signature is its source of truth.

Memory comparison for N routes: before is N closures each holding lexical references — typically hundreds of bytes per closure plus captured object graphs. After is N entries in a Map (each a small POJO) plus one shared executor function. For N=200 routes, roughly an order of magnitude reduction in per-route memory footprint. Not transformative for small apps; meaningful for labelers or AppViews proxying entire lexicon namespaces.

The registry has secondary benefits too: a future `xrpc:list` ace command iterates the registry instead of asking atcute to enumerate; phase-2 `generateXrpcControllers` codegen reads the registry to emit base classes; per-route metrics lookups become `Map.get` instead of closure-captured state.

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

### Authenticated groups

Routes that require service-JWT verification live inside a callback passed to `router.xrpc.authenticated(...)`. The same primitive declares optional auth via an `{ optional: true }` second argument — JWT verified if a Bearer token is present, request proceeds without auth if absent, throws on present-but-invalid:

```ts
// Required auth (common path):
router.xrpc.authenticated(() => {
  router.xrpc.procedure(reports.createReport, [ReportsController, 'create'])
})

// Optional auth — handler runs either way; ctx.auth.user is set if JWT present + valid:
router.xrpc.authenticated(
  () => {
    router.xrpc.query(actor.getProfile, [ProfilesController, 'show'])
  },
  { optional: true }
)
```

> **Note on architectural direction**: the atproto Lexicon spec already declares per-method auth requirements via an `auth` field (`'standard'` / `'optional'` / absent). The ideal design would derive auth-mode directly from the lexicon, removing these wrappers entirely. `@atcute/lexicons` doesn't currently expose this field at runtime — see [mary-ext/atcute#76](https://github.com/mary-ext/atcute/issues/76) for the upstream feature request. Once that lands, this package can switch to lexicon-driven authMode in a non-breaking way (the wrappers continue to work, deprecated, with auth derived from the lexicon when the field is present). For v1, the explicit wrapper-based declaration is the source of truth.

```ts
// public — no group needed
router.xrpc.subscription(labels.subscribeLabels, async function* (ctx) {
  /* ... */
})
router.xrpc.query(labels.queryLabels, [LabelsController, 'index'])

// service-JWT-authenticated procedures
router.xrpc.authenticated(() => {
  router.xrpc.procedure(reports.createReport, [ReportsController, 'create'])
  router.xrpc.procedure(reports.resolveReport, [ReportsController, 'resolve'])
  router.xrpc.query(reports.listReports, [ReportsController, 'index'])
})
```

`serviceDid` (the audience the JWT must be issued for) and `resolver` (the `DidDocumentResolver` for looking up issuer keys) come from `defineConfig`. The `lxm` claim is auto-derived from each route's lexicon NSID at registration time. No per-route override is needed for v1 — a service IS one DID; per-route audience overrides would express multi-tenancy concerns that need a different architectural answer entirely.

Inside the `authenticated(() => ...)` callback, registrations are tagged with a "needs service-JWT verification" marker before being added to the underlying `XRPCRouter`. At dispatch time, the verifier wraps `ServiceJwtVerifier` from `@atcute/xrpc-server/auth`:

1. Extracts the `Authorization: Bearer <jwt>` header.
2. Verifies signature, audience, `lxm`, expiration.
3. Populates `ctx.auth.user` (with the issuer DID) and `ctx.auth.jwt` (with the verified claims) on success.
4. Throws `AuthRequiredError` on failure — caught at the dispatch boundary and rendered as the appropriate wire-format response.

### Lifecycle phases

The `XrpcRouterBuilder.commit()` boundary establishes a well-defined ordering between route declaration and active dispatch. Concretely, in app boot order:

1. **Provider `register()`** (synchronous) — package installs the `router.xrpc` macroable getter, installs the `HttpContext.xrpc` macroable getter, and registers container singleton factories for `XRPC_ROUTER_BINDING` and `XRPC_BUILDER_BINDING`. No objects are constructed yet — the factories defer construction until first resolution. This is the synchronous-only phase per AdonisJS convention.
2. **Provider `boot()`** (async) — package reads `defineConfig({ serviceDid, resolver })` and constructs the `ServiceJwtVerifier`, calls `createNodeWebSocket()` from `@atcute/xrpc-server-node` to get the WebSocket helper (storing the returned object on the provider for use in `ready()`), then creates the `XRPCRouter` instance with `{ websocket: ws.adapter, handleException, handleSubscriptionException }` wired. Constructs the `XrpcSerializer` and the `XrpcRouterBuilder` (the builder owns its own routes map and frozen state). Constructs the shared executor via `createXrpcExecutor({ builder, xrpc, serviceJwtVerifier, xrpcSerializer })` — the executor closes over the builder so it can call `builder.find(nsid)` at dispatch time. Triggers resolution of the container singletons so they're populated by the time preloads run. The builder's routes map is empty; the `XRPCRouter` has no routes yet.
3. **Preloads** — `start/routes.ts` (and any other preload) runs. `router.xrpc.{procedure, query, subscription}(...)` calls populate the builder's registry. The `XRPCRouter` still has no routes; the builder's public methods write only to the registry.
4. **`hooks.init`** — runs after preloads. The phase-2 codegen hook (`generateXrpcControllers()`) reads the now-populated registry to emit typed abstract base classes for any controller-reference registrations. The registry is closed-to-additions at this point conceptually, but `commit()` hasn't fired yet.
5. **Provider `ready()`** — installs the Node `'upgrade'` listener (registered BEFORE atcute's, so the package's `httpContextStore.enterWith(httpCtx)` fires first in the upgrade event's synchronous chain), calls `commitRoutes(builder, xrpcRouter, executor)` to freeze the builder and wire the registered routes into atcute's XRPCRouter, then calls `ws.injectWebSocket(nodeServer, xrpcRouter)` to wire atcute's WebSocket upgrade handling. The `ws` object reused here is the same one created in `boot()`.
6. **First request** — the `XrpcDispatchMiddleware` (or the upgrade-event listener for subscriptions) hands the request to the committed `XRPCRouter`, which routes to the shared executor function.

After commit, `procedure` / `query` / `subscription` / `authenticated` all throw `RuntimeException`. This is the same boundary AdonisJS's `router.commit()` establishes — once routes are active, the declaration surface is sealed.

**HMR**: AdonisJS's HMR restarts the entire app process when `start/routes.ts` changes, which means the `XrpcRouterBuilder` is reconstructed from scratch and `commit()` re-runs naturally. No `reset()` method needed — the commit pattern works cleanly under HMR by virtue of the framework's restart semantics.

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

WebSocket connections don't traverse HTTP middleware — they're handled by the Node server's `'upgrade'` event. The package's provider `ready()` hook installs an upgrade-event listener that runs BEFORE atcute's listener (so its ALS scope is established first), then calls atcute's `injectWebSocket` to install the rest of the upgrade-handling pipeline:

```ts
async ready() {
  if (this.app.getEnvironment() !== 'web') return

  const appServer = await this.app.container.make('server')
  const nodeServer = appServer.getNodeServer()
  if (!nodeServer) return

  // Listener #1 — ours, registered FIRST so it runs first in the synchronous chain.
  // It builds the HttpContext from the upgrade request and enterWith()s it on the ALS,
  // making it available throughout the rest of atcute's processing chain (which runs
  // synchronously in the same emit('upgrade', ...) execution, then asynchronously via
  // promise continuations that inherit the ALS context).
  nodeServer.on('upgrade', (req) => {
    if (!req.url?.startsWith('/xrpc/')) return

    const synthRes = new ServerResponse(req)
    const httpRequest = appServer.createRequest(req, synthRes)
    const httpResponse = appServer.createResponse(req, synthRes)
    const resolver = this.app.container.createResolver()
    const httpCtx = appServer.createHttpContext(httpRequest, httpResponse, resolver)

    // Mirror container_bindings_middleware bindings for the subscription path:
    resolver.bindValue(HttpContext, httpCtx)
    resolver.bindValue(Logger, httpCtx.logger)

    httpContextStore.enterWith(httpCtx)
  })

  // Commit: freeze the builder and wire registered routes into the XRPCRouter.
  // After this point, builder.procedure/query/subscription/authenticated throw.
  commitRoutes(this.builder, this.xrpcRouter, this.executor)

  // Listener #2 — atcute's, registered SECOND. Its emit-time execution inherits our
  // store via the same synchronous-chain → async-continuation propagation.
  // The same `ws` object was created during boot() (so its `ws.adapter` could
  // be passed into the XRPCRouter constructor); we reuse it here to install the
  // upgrade listener.
  this.ws.injectWebSocket(nodeServer, this.xrpcRouter)
}
```

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

```ts
class XrpcContext<L extends XrpcLexicon> {
  // HttpContext-mirrored properties (inherited from the triggering HttpContext for HTTP-side
  // dispatch, or from the synthetic HttpContext for subscriptions):
  request: Request // Fetch Request (atcute speaks Fetch)
  response: XrpcResponse<L> // typed against the lexicon's output schema
  logger: Logger // request-scoped
  containerResolver: ContainerResolver
  requestId: string // sourced from HttpRequest.id() (x-request-id header) or generated if absent

  // XRPC-specific properties:
  input: InferInput<L> // typed body input for procedures
  params: InferParams<L> // typed query parameters
  lexicon: L // the lexicon spec object (handler self-reference)

  // Auth — populated by dispatch when inside an authenticated() group:
  auth: XrpcAuth

  // Subscription-only — only meaningful when L is a subscription lexicon:
  stream: XrpcStream<L>
}

class XrpcAuth {
  // Constructed by the dispatcher with the request, the matched lexicon, and a verifier
  // (or null if the route's authMode is 'none'). Verification runs lazily on the first
  // accessor call and is memoized — required-auth routes pre-trigger via the dispatcher
  // for fail-fast semantics; optional-auth routes verify on-demand.
  constructor(request: Request, lexicon: XrpcLexicon, verifier: ServiceJwtVerifier | null)

  // Accessors are async because verification may fire on first call. Subsequent calls
  // return the memoized result.
  getUserOrFail(): Promise<Did> // throws AuthRequiredError if no JWT or invalid
  getJwtOrFail(): Promise<VerifiedJwt> // throws AuthRequiredError if no JWT or invalid
  getUser(): Promise<Did | undefined> // returns undefined if no JWT (optional-auth case)
  getJwt(): Promise<VerifiedJwt | undefined>
}

class XrpcStream<L extends XrpcSubscriptionLexicon> {
  readonly aborted: boolean // shortcut for ctx.stream.signal.aborted
  readonly signal: AbortSignal // for passing into downstream abortable APIs

  // Typed message builder — narrows payload to the specific ref's schema:
  message<R extends XrpcMessageRef<L>>(ref: R, payload: XrpcMessagePayload<L, R>): XrpcMessage<L>
}

class XrpcResponse<L extends XrpcLexicon> {
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

Subscription handlers are async generators yielding messages built via `ctx.stream.message(ref, payload)`. The builder constructs a properly-typed message object with the `$type` discriminator automatically derived from the lexicon's NSID plus the ref name, and narrows the `payload` argument to the specific ref's schema.

```ts
async *subscribe(ctx: XrpcContext<typeof labels.subscribeLabels>) {
  if (ctx.params.cursor !== undefined) {
    const current = await labelStore.currentSeq()
    if (ctx.params.cursor > current) {
      throw new FutureCursorError('cursor is from the future')
    }
  }

  for await (const label of labelStore.iterFromCursor(ctx.params.cursor, ctx.stream.signal)) {
    if (ctx.stream.aborted) return

    yield ctx.stream.message('#labels', {
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
- **`ctx.stream.signal.aborted`** = the client disconnected — generator should return to terminate cleanly

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

The provider reads this config during `register()` and uses it to construct the `ServiceJwtVerifier` instance shared by all `authenticated()` route registrations.

## Kernel registrations

```ts
// start/kernel.ts
import server from '@adonisjs/core/services/server'
import xrpc from '@thisismissem/adonisjs-atproto-xrpc/services/xrpc'

server.errorHandler(() => import('#exceptions/handler'))
xrpc.errorHandler(() => import('#exceptions/handler')) // SAME factory — one class to maintain
```

Both registrations point at the same factory file. The consumer's `app/exceptions/handler.ts` extends Adonis's `HttpExceptionHandler`; the XRPC service uses only `report()` and `shouldReport()` from it, skipping `handle()` (whose content-negotiation logic doesn't apply to XRPC's fixed wire format).

The XRPC service singleton (`@thisismissem/adonisjs-atproto-xrpc/services/xrpc`) mirrors `@adonisjs/core/services/server` in shape — six lines:

```ts
import app from '@adonisjs/core/services/app'
let xrpc
await app.booted(async () => {
  xrpc = await app.container.make('xrpc')
})
export { xrpc as default }
```

The provider binds `'xrpc'` to an `XrpcService` instance:

```ts
class XrpcService {
  #errorHandlerFactory?: LazyImport<XrpcExceptionHandler>
  #resolvedErrorHandler?: XrpcExceptionHandler // memoized after first resolution

  constructor(private app: ApplicationService) {}

  /**
   * Register the XRPC exception handler factory. Called from kernel.ts during
   * preload — the factory itself is invoked lazily on first error.
   */
  errorHandler(factory: LazyImport<XrpcExceptionHandler>): this {
    this.#errorHandlerFactory = factory
    return this
  }

  /**
   * Resolve and memoize the registered exception handler. Called by the
   * shared executor function when an error needs to be reported. Returns null
   * if no factory was registered (e.g., tests, or consumers who don't want
   * XRPC-specific error handling).
   */
  async getRegisteredErrorHandler(): Promise<XrpcExceptionHandler | null> {
    if (this.#resolvedErrorHandler) return this.#resolvedErrorHandler
    if (!this.#errorHandlerFactory) return null
    const mod = await this.#errorHandlerFactory()
    this.#resolvedErrorHandler = await this.app.container.make(mod.default)
    return this.#resolvedErrorHandler
  }
}
```

The `errorHandler(factory)` registration is late-bound: `kernel.ts` runs after the package's `boot()` (kernel.ts is loaded as a preload), so the `XrpcService` instance must exist before the registration call, and the factory is held until first resolution. This is the same pattern Adonis uses for `server.errorHandler(...)` — the resolved handler is cached after first use.

The shared executor function receives the `XrpcService` instance (alongside the `RouteRegistry`, `ServiceJwtVerifier`, and `XrpcSerializer`) via the surrounding closure when `createXrpcExecutor({ ... })` constructs it during provider `boot()`. The executor calls `xrpc.getRegisteredErrorHandler()` from inside its catch block when an error needs to be reported:

```ts
// Inside the executor's catch block:
const errorHandler = await xrpc.getRegisteredErrorHandler()
await errorHandler?.report(err, httpCtx)
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
    xrpc?: XrpcContext<any>
  }
}
```

For HTTP-triggered XRPC errors, the XRPC dispatch middleware binds `XrpcContext` on the inherited resolver. For subscription-triggered errors, the upgrade-event listener does the same on the synthetic HttpContext's resolver. Either way, `httpCtx.xrpc` returns the `XrpcContext` whenever an XRPC error is being reported.

The consumer's `report()` method can optionally inspect `ctx.xrpc` for XRPC-specific tagging without writing two handlers:

```ts
// app/exceptions/handler.ts
import { ExceptionHandler, HttpContext } from '@adonisjs/core/http'
import { Sentry } from '#start/sentry'

export default class HttpExceptionHandler extends ExceptionHandler {
  async report(error: unknown, ctx: HttpContext) {
    Sentry.captureException(error, {
      tags: {
        ...(ctx.xrpc && {
          nsid: ctx.xrpc.lexicon.id,
          method: ctx.xrpc.lexicon.defs.main.type,
        }),
      },
      user: ctx.xrpc?.auth.user ? { id: ctx.xrpc.auth.user } : undefined,
    })
    return super.report(error, ctx)
  }
}
```

## HTTP-context constraint for subscriptions

Adonis's `HttpContext.getOrFail()` static accessor reads from a _private_ `AsyncLocalStorage` instance that Adonis only enters during normal HTTP request processing (when `useAsyncLocalStorage` is true in `config/app.ts`). The XRPC package cannot enter that ALS from outside.

**Consequence**: inside a subscription handler, `HttpContext.getOrFail()` will return null or throw, even though a synthetic HttpContext exists for the subscription's lifetime. Code that uses the static accessor will behave differently between HTTP-triggered and subscription-triggered paths.

**Recommendation for consumers**: use `XrpcContext` (the parameter passed to your handler, or via `@inject(XrpcContext)`) instead of `HttpContext.getOrFail()` when writing code that needs to be subscription-safe. The XRPC package's `HttpContext` macroable getter (`httpCtx.xrpc`) only goes the one direction — it doesn't make `HttpContext.getOrFail()` work in subscription contexts.

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

Consumer-facing usage stays clean — handlers return body-shape objects with transformer contracts embedded:

```ts
async list(ctx: XrpcContext<typeof reports.listReports>) {
  const reports = await Report.query()
    .where('audience', ctx.auth.getUserOrFail())
    .orderBy('createdAt', 'desc')
    .limit(ctx.params.limit ?? 50)

  return {
    cursor: reports.at(-1)?.createdAt.toISO(),
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

The `XrpcSerializer` is exposed as a config knob — consumers can supply their own subclass via `defineConfig({ serializer: MyCustomSerializer })` if they need to customize wrap keys or pagination metadata transformation. Most consumers won't.

## Error handling

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

**Phase 2 (follow-up)**: `generateXrpcControllers()` hook ships, integrated into AdonisJS's `hooks.init` mechanism. The hook reads the registered XRPC routes at app-init time (after preloads, including `start/routes.ts`, have populated the package's internal registry) and emits abstract base classes in `.adonisjs/types/xrpc/controllers.d.ts`. Controller-reference handlers extend the generated base, gaining typed `XrpcContext<L>` method signatures without explicit annotation:

```ts
// adonisrc.ts (consumer)
import { generateXrpcControllers } from '@thisismissem/adonisjs-atproto-xrpc/hooks'

export default defineConfig({
  hooks: {
    init: [
      indexEntities({
        /* ... */
      }),
      indexPages({ framework: 'react' }),
      generateRegistry(), // Tuyau
      generateXrpcControllers(), // <-- this package, phase 2
    ],
  },
})

// Generated (gitignored):
// .adonisjs/types/xrpc/controllers.d.ts
export declare abstract class GeneratedReportsController {
  abstract create(
    ctx: XrpcContext<typeof reports.createReport>
  ): Promise<XrpcResponseBody<typeof reports.createReport>>
  abstract resolve(
    ctx: XrpcContext<typeof reports.resolveReport>
  ): Promise<XrpcResponseBody<typeof reports.resolveReport>>
}

// app/controllers/reports_controller.ts (consumer)
import { GeneratedReportsController } from '#xrpc/controllers'

export default class ReportsController extends GeneratedReportsController {
  async create(ctx) {
    // no annotation needed
    const { reasonType, subject } = ctx.input // typed from extended base
    return { id: '...' }
  }
}
```

The phase 2 transition is **non-breaking**: the optional generic stays in the type definition forever; what changes is whether consumers explicitly pass it. Inline handlers work identically in both phases.

The codegen uses runtime route-registry inspection rather than static analysis of `start/routes.ts`, so dynamic registration (loops, helpers, conditionals) is supported.

## Testing

### `xrpc.createContext()`

The XRPC service singleton exposes `createContext()` paralleling Adonis's `server.createHttpContext()`. It takes an HttpContext as the source of `logger` / `containerResolver` / `requestId`, plus the XRPC-specific fields (`lexicon`, `input`, `params`, `auth`, `request`). The dispatch path uses it; tests use it.

```ts
import xrpc from '@thisismissem/adonisjs-atproto-xrpc/services/xrpc'
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import { fyi } from '#lexicons'

test('reports.create handler creates a report and returns the id', async ({ app }) => {
  // Adonis's own HttpContextFactory gives us a test-friendly HttpContext:
  const httpCtx = new HttpContextFactory().create()

  const ctx = await xrpc.createContext({
    httpCtx,
    lexicon: fyi.questionable.reports.create,
    input: { reasonType: 'spam', subject: { uri: 'at://...', cid: '...' } },
    auth: {
      user: 'did:plc:abc',
      jwt: { issuer: 'did:plc:abc', audience: SERVICE_DID, lxm: NSID },
    },
  })

  const controller = await app.container.make(ReportsController)
  const result = await controller.create(ctx)

  assert.equal(result.id, '...')
})
```

`xrpc.createContext()` derives `logger` / `containerResolver` / `requestId` from the passed `httpCtx`. The caller only specifies the XRPC-specific fields. Defaults apply where the lexicon's schema permits (e.g., `input` is `undefined` if the lexicon doesn't define one for a query/subscription).

### Subscription testing

Subscription handlers can be tested as plain async generators by constructing an `XrpcContext` with a stream signal:

```ts
test('subscribeLabels yields backfill events from cursor', async ({ app }) => {
  const httpCtx = new HttpContextFactory().create()
  const abortController = new AbortController()

  const ctx = await xrpc.createContext({
    httpCtx,
    lexicon: labels.subscribeLabels,
    params: { cursor: 100 },
    signal: abortController.signal,
  })

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

// app/controllers/labels_controller.ts (in the labeler package)
import { inject } from '@adonisjs/core'
import type { Labeler } from '@atcute/labeler'

@inject()
export default class LabelsController {
  constructor(protected labeler: Labeler) {}

  async *subscribe(ctx: XrpcContext<typeof labels.subscribeLabels>) {
    for await (const event of this.labeler.subscribeLabels({
      cursor: ctx.params.cursor,
      signal: ctx.stream.signal,
    })) {
      if (ctx.stream.aborted) return
      yield ctx.stream.message('#labels', event)
    }
    // FutureCursorError thrown deep in labeler.subscribeLabels propagates up;
    // the package's error-mapper maps it to the lexicon's #FutureCursor error event
    // by matching FutureCursorError.errorName against the lexicon's declared errors.
  }
}

// errors.ts (in the labeler package)
export class FutureCursorError extends XrpcError {
  static status = 400
  static errorName = 'FutureCursor' // matches lexicon's errors[].name
}
```

The migration eliminates:

- The spread-with-`$type` dance (replaced by `ctx.stream.message('#labels', event)`, which type-checks the payload against the ref's schema exactly)
- The catch-and-rethrow for `FutureCursorError` (replaced by making `FutureCursorError` an `XrpcError` subclass whose `errorName` matches the lexicon's declared error name)

The labeler's `subscribeLabels` method (the underlying `@atcute/labeler` API) is unchanged — only the registration shape and the wrapping layer change.

## Open implementation details

These can be settled during writing-plans / implementation; they don't affect the architectural surface.

### Provider boot ordering for the labeler refactor

The labeler-package's provider needs `router.xrpc` available at its own boot — meaning the XRPC package's provider must run first. AdonisJS provider ordering can be controlled via the `aliases` field or by registration order in `adonisrc.ts`. Verify during the labeler migration.

### CORS configuration interaction

`@adonisjs/cors` runs before this package's dispatch middleware in the `server.use([...])` chain, so XRPC requests inherit Adonis's CORS configuration. XRPC clients (Bluesky web app, etc.) may need specific origins / methods / headers different from the rest of the application. Default: consumer-side responsibility — configure CORS to be permissive enough for both XRPC and regular HTTP. Document this in the README.

### Provider for the response-helper degenerate-write protection

The synthetic HttpContext for subscriptions has a degenerate `HttpResponse` (writes go nowhere because the upgrade socket has been hijacked). Defensive measure for v1: wrap the response in a Proxy that throws on write attempts during subscription error reporting, surfacing misuse early instead of silent no-ops.

### TypeScript inference for handlers

The signature `procedure<L>(lexicon: L, handler: ...)` relies on TypeScript inferring `L` from the lexicon argument. For inline handlers this works directly. For controller-reference handlers, the `MethodOf<Controller, Arg>` conditional-type pattern (similar to Adonis's own router types) enforces that the named method accepts `XrpcContext<L>`. Verify the inference at implementation time; phase-2 codegen sidesteps this entirely.

### Request ID generation for subscriptions

`HttpRequest.id()` returns the value from the `x-request-id` header — `string | undefined`. AdonisJS additionally has `generateRequestId: boolean` in `config/app.ts` which auto-generates an ID when the header is missing. For HTTP-triggered XRPC routes this works as normal because the HttpContext is constructed by Adonis's pipeline (which respects the config).

For subscriptions, the synthetic HttpContext is constructed manually by the package at the `'upgrade'` event — we need to decide whether to respect the same `generateRequestId` config when synthesizing, or always generate one, or surface `undefined`. Worth a closer look during implementation; safest default is probably "always generate a fallback ID for the synthetic HttpContext" so subscription error reports always have correlation, but verify the behavior against `config/app.ts`'s knob to avoid surprising the consumer.

## Future work

Items the package might grow into post-v1:

- **Lexicon-driven authMode** — switch from the wrapper-based `authenticated()` / `authenticated(..., { optional: true })` declaration to deriving auth-mode directly from the lexicon's `auth` field. Blocked on [mary-ext/atcute#76](https://github.com/mary-ext/atcute/issues/76) (atcute needs to expose the lexicon's `auth` field on its runtime metadata). Non-breaking migration: the wrapper continues to work alongside lexicon-driven auth; new registrations can omit the wrapper once the lexicon declares its own auth contract.
- **Rate-limit middleware integration** — `@adonisjs/limiter` interop, per-route limits via a `rateLimited(() => ...)` callback paralleling `authenticated(() => ...)`.
- **OAuth-flow middleware** — for endpoints requiring user-OAuth-style auth (vs service JWTs). When atproto OAuth lands in `@atcute/*`, this package could provide the AdonisJS bridge.
- **Service-JWT minting helpers** — for outbound XRPC calls. Currently a consumer concern via `createServiceJwt` from `@atcute/xrpc-server/auth`; could be wrapped.
- **Subscription error reporting hook** — if the synthetic-HttpContext approach has edge cases for some consumers, a dedicated `defineConfig({ onSubscriptionError })` hook becomes the explicit escape valve.
- **`XrpcContext.getOrFail()` static accessor** — paralleling Adonis's `HttpContext.getOrFail()`. Currently consumers access `XrpcContext` via DI (`@inject(XrpcContext)`) or via the handler parameter; a static accessor would close the discoverability gap.
- **`xrpc:list` ace command** — list registered XRPC endpoints for debugging.

## Related work

- `docs/specs/2026-05-17-adonisjs-atproto-xrpc-design.md` — superseded by this document; preserved for traceability.
- `@thisismissem/adonisjs-atproto-labeler` — the existing labeler package; first consumer of this one.
- `@atcute/xrpc-server` — the underlying XRPC routing library this package wraps.
- `@atcute/xrpc-server-node` — the Node-specific WebSocket adapter (creates `wss`, hooks `'upgrade'`, handles connection lifecycle).
- `@atcute/xrpc-server/auth` — service-JWT verification primitives.
- `@adonisjs/http-transformers` — the transformer / serializer primitives this package's `XrpcSerializer` extends.
- `@poppinss/exception` — the base class for `XrpcError`.
