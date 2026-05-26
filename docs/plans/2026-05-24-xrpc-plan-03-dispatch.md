# XRPC Plan 03 — Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Model:** Claude Sonnet (current generation) — the design and audit work is settled in the spec and plans; execution is mechanical enough that Opus is overkill.

**Goal:** Ship the dispatch layer — the shared executor that drives every registered XRPC handler, `XrpcServer` that owns the `@atcute/xrpc-server` `XRPCRouter` + WebSocket adapter, and `XrpcDispatchMiddleware` that intercepts `/xrpc/*` HTTP requests. After this plan, a hand-constructed `XrpcRouter` + `XrpcServer` pair can dispatch real HTTP procedures, HTTP queries, and WebSocket subscriptions end-to-end — without provider lifecycle and without error-reporter integration. Plan 04 (provider) layers those on top by splicing into the single error-reporting seam left here.

**Architecture:** The atcute `XRPCRouter` and the `createNodeWebSocket()` helper share one executor function (registered once per route) — this is the closure-deduplication pattern locked in by the spec. The executor takes `(atcuteCtx, requestCtx: RequestContext)` — the second arg is materialized at the dispatch boundary on both paths, not read from any ALS inside the executor. `RequestContext` carries `{ requestId, request: HttpRequest, logger, containerResolver }` — the Adonis `HttpRequest` is the public-facing request surface (`ctx.request.validateUsing(...)` etc.), atcute's Fetch `Request` is an executor-internal detail. The executor is error-reporter-agnostic (Plan 04 widens it for error reporting via `XrpcService`). The HTTP-side path runs as Adonis server-level middleware in `start/kernel.ts`'s `server.use([...])` chain — the middleware enters the package-internal `requestContextStore` with a `RequestContext` derived from the triggering `HttpContext` (via `fromHttpContext(ctx)`) and short-circuits on path match. The WebSocket-side path snips atcute's `'upgrade'` listener after `injectWebSocket` registers it and replaces it with a URL-filtering wrapper that builds a `RequestContext` directly from the upgrade `IncomingMessage` + `app` (the `HttpRequest` is constructed via `appServer.createRequest(req, synthRes)` — no synthetic `HttpContext`), enters `requestContextStore`, and falls through to other listeners (Vite HMR, app-defined WS endpoints) for non-XRPC URLs.

**Tech Stack:** TypeScript (ESM), Node ≥24, `@atcute/xrpc-server` (new dep), `@atcute/xrpc-server-node` (new dep), `@adonisjs/core` (peer; for `HttpContext`, `Logger`, `ApplicationService`, `Server`), `@japa/runner` + `@japa/assert` for tests, real HTTP servers + a WebSocket client for functional tests.

**Spec reference:** `docs/specs/2026-05-21-adonisjs-atproto-xrpc-design.md` §§ _XrpcServer — internal dispatch orchestrator_, _Dispatch: HTTP middleware (procedure + query)_, _Dispatch: WebSocket upgrade (subscription)_, _Subscription dispatch — executor branches_, _Lifecycle phases_.

**Implementation scope:** The plan series (01–04) lands the XRPC package up to — but not including — auth. The design spec covers auth in full because the overall system had to be designed knowing where the seams sit and how `XrpcContext` would be shaped, but a plan-executing implementor doesn't need to think about auth at all: there are no auth-related comment-anchors, types, or "Plan 05 will splice here" placeholders left in code. When the auth work is eventually planned, it will lay its own seams against whatever the codebase looks like at that point. Plan 01's `RouteInfo` deliberately has no `auth` field — Plan 05 will graft `auth: RouteAuthDecl` onto it via declaration merging. Plan 03 neither constructs an `XrpcAuth`, nor pre-triggers verification, nor surfaces an `auth` field on `XrpcContext`.

**Depends on:** Plan 01 (foundation) — `src/types.ts`, `src/router.ts` (`XrpcRouter`, `RouteInfo`, `NormalizedHandler`, `XrpcHandlerInput`; **handler normalization runs at register time** via fold's `moduleCaller`/`moduleImporter`, so Plan 03's executor consumes the normalized shape directly and does no handler resolution of its own), `src/context.ts` (`XrpcContext`, `XrpcContext.als`, `XrpcResponse`, `XrpcStream`), `src/errors.ts` (`XrpcError`, `InternalServerError`, `NotFoundError`), `src/utils.ts` (`adonisRequestToWebRequest`, `writeWebResponseToAdonisResponse`). Plan 02 (serializer) — `src/serializer.ts` (`XrpcSerializer`).

---

## Files

### Create

- `src/request_context.ts` — `RequestContext` type + `requestContextStore: AsyncLocalStorage<RequestContext>` (the package-internal ALS that bridges the dispatch boundary to the registered atcute closure — entered by the HTTP middleware on the procedure/query path, and by `#installWebSocketHandler` on the subscription path) + `fromHttpContext(httpCtx)` helper that materializes a `RequestContext` from an Adonis HttpContext. Lives in its own module (rather than inside `xrpc_server.ts`) so the three pieces stay grouped — both `XrpcServer` and `XrpcDispatchMiddleware` import from here.
- `src/xrpc_server.ts` — `XrpcServer` class + `createXrpcExecutor` + `wrapSubscriptionIterator`. Imports `RequestContext` + `requestContextStore` from `./request_context.js`. Controller resolution is **not** in this file — Plan 01's `XrpcRouter.#normalizeHandler` already ran at register time, so `route.handler` arrives pre-normalized.
- `src/middleware/dispatch.ts` — `XrpcDispatchMiddleware` (server-level middleware that intercepts `/xrpc/*`)
- `providers/provider.ts` — minimal `XrpcProvider` that installs the `router.xrpc` Macroable getter + mounts the dispatch middleware (in `boot()`) and constructs/starts the `XrpcServer` (in `ready()`). Scope-limited for Plan 03; Plan 04 expands with `XrpcService` facade + error-reporter wiring + `HttpContext.xrpc` getter
- `tests/provider.spec.ts` — unit tests verifying the provider installs the router getter, commits + starts XrpcServer on `ready()`, and skips wiring in non-web environments
- `src/event-stream/framing.ts` — public atproto event-stream frame decode/encode utility surface. Exports `decodeFrame(buffer)`, `encodeFrame(frame)`, and the typed `DecodedFrame` discriminated union (`{ type: 'message', body, discriminator? } | { type: 'error', error, message? }`), plus `FrameHeader` / `ErrorFrameBody` interfaces. Atcute provides the CBOR primitives (`@atcute/cbor`) but doesn't ship a high-level frame decoder — this fills the gap for both this package's own `test_utils.injectXrpcSubscription` and consumer code (the labeler currently has a hand-rolled `framing.ts` that this surface supersedes). Reachable as `@thisismissem/adonisjs-atproto-xrpc/event-stream/framing`.
- `tests/event-stream/framing.spec.ts` — round-trip + decode + encode + error-frame + invalid-header tests
- `src/test_utils.ts` — public test-helpers surface (single file at the `src/` level, not a directory + index — there's only one helper). Exports `injectXrpcSubscription(server, lexicon, options?)` — XRPC-aware wrapper over `light-my-websocket`'s `injectWS` that constructs `/xrpc/<lexicon.id>` URLs, decodes atproto frames via `decodeFrame` from `./event-stream/framing.js`, and returns an `InjectedXrpcSubscription` exposing `messages()` as an `AsyncIterable<DecodedFrame>` plus `close()`. The generic synthetic-upgrade plumbing is provided by [`light-my-websocket`](https://npmjs.com/package/light-my-websocket) (Emelia's own published extraction). HTTP-side helpers (`injectXrpcQuery`, `injectXrpcProcedure`) are deferred to a follow-up.
- `tests/xrpc_server.spec.ts` — unit tests for `XrpcServer.#installRoutes` (verifies the right `add*` method called per lexicon kind), `createXrpcExecutor` (verifies handler resolution + invocation + serialization + error wrapping), and `wrapSubscriptionIterator` (verifies async-iterable wrapping + per-yield serialization + error translation)
- `tests/test_utils.spec.ts` — unit tests for `injectWS` (synthetic upgrade succeeds against a stub server that calls `wss.handleUpgrade`) and `injectXrpcSubscription` (correct URL constructed; CBOR frame decoding yields typed messages; `close()` cleans up the socket)
- `tests/dispatch.spec.ts` — functional test exercising HTTP procedure + HTTP query end-to-end against an Adonis pipeline driven via `light-my-request` (using `setupApp` from `tests/helpers.ts` — **pre-existing fixture from the initial scaffolding commit `096e257`, not introduced by Plan 03 or any earlier plan; do not create or rewrite it**) with a hand-constructed `XrpcRouter` / `XrpcServer` pair
- `tests/dispatch_subscription.spec.ts` — functional test exercising WebSocket subscription end-to-end against the Adonis pipeline driven via `injectXrpcSubscription` (no port binding — synthetic-upgrade pattern). Verifies frames decode correctly and that downstream `XrpcContext.getOrFail()` works inside subscription handler yields.

### Modify

- `package.json` — add runtime deps `@atcute/xrpc-server`, `@atcute/xrpc-server-node`, `@atcute/cbor`, `light-my-websocket`, `ws`; add devDeps `light-my-request`, `@types/ws`; extend `tsdown.entry` for the new files; add `./middleware`, `./test_utils`, and `./event-stream/framing` subpath exports
- `tests/helpers.ts` — Task 7b Step 4 extends the existing `app.start(cb)` block to mount the dispatch middleware before `setNodeServer`, so tests loading the provider get an end-to-end pipeline. Pre-existing fixture from `096e257` is otherwise untouched
- `index.ts` — no changes (dispatch internals stay internal; the middleware default-export becomes reachable via the `./middleware` subpath, and the test helpers via the `./test_utils` subpath)

### Out of scope (later plans)

- **`XrpcService` facade + `errorHandler(factory)` registration** → Plan 04. The executor's catch block has an explicit seam (`// ERROR-REPORTING SEAM (Plan 04)`) where Plan 04 will splice `await xrpc.getRegisteredErrorHandler()?.report(...)` before the `throw`. Plan 03 just throws after wrapping non-`XrpcError` exceptions as `InternalServerError`.
- **Provider lifecycle** — the **minimal** provider is in Plan 03 (Task 7b) so the functional tests can load it via `rcFileContents.providers` instead of hand-rolling XrpcServer construction in `beforeReady`. Plan 04 expands the provider with `XrpcService` facade, error-reporter registration, `HttpContext.xrpc` Macroable getter, and atcute's `handleException` / `handleSubscriptionException` wiring.
- **`HttpContext.xrpc` getter** → Plan 04 (provider's register phase installs the Macroable getter).
- **Ace commands** (`list:xrpc:routes`, `make:xrpc:controller`) → Plan 06.
- **`indexXrpc()` codegen hook** → Plan 07.

---

## Pre-flight checks

- [ ] **Step 0: Confirm we are on a clean working tree and Plans 01–02 are committed**

Run:

```bash
git status
git log --oneline -10
```

Expected: working tree clean (or only this plan file untracked); commits from Plans 01 and 02 reachable. If those plans haven't been executed, Plan 03 can still be drafted — but it CAN'T be executed until 01/02's exports exist.

---

## Task 1a: Add atcute dispatch + Node-WS deps

**Files:**

- Modify: `package.json` (dependencies)

**Steps:**

- [ ] **Step 1: Add the two runtime deps**

Run:

```bash
pnpm add @atcute/xrpc-server @atcute/xrpc-server-node
```

Expected: two entries added under `dependencies` in `package.json`; lockfile updated. No build/postinstall failures. `sfw` may print packfile inspection notices — that's expected; both atcute packages are from the `mary-ext/atcute` org (which the project already trusts via the `@atcute/lexicons` dep added in Plan 01).

These are the deps consumed by `XrpcServer` + `createXrpcExecutor` + the dispatch middleware (Tasks 2-8). Test-utils deps are split into Task 1b so the package's core wiring can be verified before any test-injection scaffolding lands.

- [ ] **Step 2: Confirm `@atcute/xrpc-server` exists and exposes the APIs the spec assumes**

Run:

```bash
pnpm info @atcute/xrpc-server version
pnpm info @atcute/xrpc-server exports
node -e "const m = await import('@atcute/xrpc-server'); console.log(Object.keys(m).sort())"
```

Expected: a published version (any recent), and the export list includes `XRPCRouter`. We rely on these APIs:

- `XRPCRouter` class with constructor accepting `{ websocket?: <ws adapter>, handleException?: fn, handleSubscriptionException?: fn }`.
- `XRPCRouter.prototype.addProcedure(lexicon, { handler })`.
- `XRPCRouter.prototype.addQuery(lexicon, { handler })`.
- `XRPCRouter.prototype.addSubscription(lexicon, { handler })`.
- `XRPCRouter.prototype.fetch(request: Request): Promise<Response>` — the Web-Fetch entry point.
- Context types `UnknownOperationContext` (HTTP path) and `UnknownSubscriptionContext` (WS path) — both carry `request`, `params`, `signal`; operation context additionally carries `input`.
- Convenience error classes (`XRPCSubscriptionError` — used by the subscription error frame encoding).

If any names differ, record the actual names and adjust Task 3 / Task 4 / Task 5 imports accordingly. The spec uses the nominal names.

- [ ] **Step 3: Confirm `@atcute/xrpc-server-node` exists and exposes `createNodeWebSocket()` + verify listener-registration shape**

Run:

```bash
pnpm info @atcute/xrpc-server-node version
node -e "const m = await import('@atcute/xrpc-server-node'); console.log(Object.keys(m).sort())"
```

Expected: `createNodeWebSocket` is exported. The return shape we rely on is `{ adapter, wss, injectWebSocket(nodeServer, xrpcRouter) }`. If the function name or shape differs, adjust Tasks 5 and 6 accordingly.

**Also**: open `packages/servers/xrpc-server-node/lib/index.ts` in the local atcute clone (`~/Development/git/github.com/mary-ext/atcute/packages/servers/xrpc-server-node/lib/index.ts` on `trunk`) and confirm `injectWebSocket` **registers exactly one `'upgrade'` listener** via `server.on('upgrade', ...)`. Plan 03's `XrpcServer.#installWebSocketHandler` (Task 6) calls `injectWebSocket` and then captures + removes that single listener (snip-and-wrap pattern). If atcute starts registering multiple listeners, uses `prependListener`, or installs via a different mechanism, the runtime guard in `#installWebSocketHandler` throws — but we want to know at plan-execution time rather than runtime, so record any change here.

Verified as of trunk: line 50 of that file is `server.on('upgrade', async (request, socket, head) => { ... })`. Exactly one listener, plain `.on()`. ✓

**Why we snip-and-wrap atcute's listener** (rather than register a sibling): atcute's listener doesn't filter by URL prefix — it runs `router.fetch(webRequest)` on every upgrade and writes the response back via `socket.end(...)` if no XRPC subscription matched. Without our wrapper, that breaks **Vite HMR in dev** (AdonisJS's Vite integration WS upgrades would get 404'd) and any consumer-defined non-XRPC WS endpoint. The wrapper checks the URL prefix and falls through cleanly for non-XRPC upgrades.

**TODO (upstream)**: file an issue / PR against `mary-ext/atcute` adding an optional `urlPredicate: (req: IncomingMessage) => boolean` to `createNodeWebSocket`. With that, our `#installWebSocketHandler` collapses to a single `injectWebSocket` call with `urlPredicate: (req) => req.url?.startsWith('/xrpc/')` and no snip-and-wrap. Not blocking Plan 03.

- [ ] **Step 4: Typecheck to confirm clean resolution**

Run: `pnpm typecheck`
Expected: zero errors (nothing imports from the new deps yet).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "feat(xrpc): add @atcute/xrpc-server + @atcute/xrpc-server-node deps for dispatch"
```

---

## Task 1b: Add deps for the `test_utils` injection helpers

**Files:**

- Modify: `package.json` (dependencies + devDependencies)

**Steps:**

- [ ] **Step 1: Add the runtime + test deps**

Run:

```bash
pnpm add @atcute/cbor light-my-websocket ws
pnpm add -D light-my-request @types/ws
```

Expected: three entries added under `dependencies` and two under `devDependencies` in `package.json`; lockfile updated.

**Install caveat — `light-my-websocket` may trip `minimumReleaseAge`**: the package was first published on 2026-05-25 (Emelia's own publication, extracted from this plan's inline design). Until the project-configured `minimumReleaseAge` window (typically 24–72h) has elapsed since publication, `pnpm add` will reject the install with a release-age error. The package is also unscoped (no `@thisismissem/` prefix), so no scope-level allowlist applies. Options:

- **Preferred**: wait for the release-age window to pass, then run the install normally.
- **If executing under time pressure**: temporarily allowlist the specific version in `.npmrc` or pin via `pnpm add light-my-websocket@<version> --allow-recent` (or whatever override flag the installed pnpm version supports — verify against `pnpm install --help`). Document the override in the commit message.
- Do NOT lower the global `minimumReleaseAge` to install this — that weakens the supply-chain posture for every future install. Per-package override only.

**Why these are runtime deps and not devDeps**: the `test_utils` subpath we ship in Task 9 is a public-API surface — consumers import `@thisismissem/adonisjs-atproto-xrpc/test_utils` from their own test files. If `@atcute/cbor` / `light-my-websocket` / `ws` were devDeps, consumers' `pnpm install` of our package wouldn't resolve them, and their tests would fail with "cannot find module" at run time. The test-utils code only loads when the subpath is imported (consumers' production bundles don't pull it in), so the runtime-deps designation costs nothing at consumer build time.

Dep roles:

- `@atcute/cbor` — used by `injectXrpcSubscription` to decode the atproto frame format (two concatenated CBOR objects per frame: header + body)
- `light-my-websocket` — synthetic-upgrade helper modelled after `fastify-websocket`'s internal `injectWS`. Provides the `injectWS(server, url?, options?)` primitive that emits `'upgrade'` on a Node server with a Duplex-pair fake socket — no port binding. Lifted from Emelia's own [npm package](https://npmjs.com/package/light-my-websocket); replaces what would have been an inlined `src/test_utils/inject_websocket.ts` here
- `ws` — peer dep of `light-my-websocket`; also a transitive dep of `@atcute/xrpc-server-node`. We depend on it directly so the import is explicit. `@types/ws` is the typings convention even though modern `ws` ships its own
- `light-my-request` — HTTP request injection for Task 8 (HTTP functional test). Test-only, so devDep. Same library `fedimod/fires` uses in `tests/plugins/request_tests.ts`

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: zero errors (nothing imports from these deps yet).

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "feat(xrpc): add test_utils injection deps (@atcute/cbor, light-my-websocket, ws, light-my-request)"
```

---

## Task 2: Define the dispatch-layer types and stubs

**Files:**

- Create: `src/request_context.ts` — `RequestContext` type + `requestContextStore` ALS + `fromHttpContext` helper
- Create: `src/xrpc_server.ts` (initial — skeleton `XrpcServer` class with `start()` body stubbed to a TODO comment, and a stub `createXrpcExecutor` factory; imports `RequestContext` + `requestContextStore` from `./request_context.js`)

This task establishes the module shape so subsequent tasks (executor, WS handler, middleware) can import the right symbols without circular-dependency surprises. The `RequestContext` triplet (type + ALS + helper) gets its own module so the three pieces stay grouped — both `XrpcServer` and `XrpcDispatchMiddleware` (Task 7) import from it.

**Steps:**

- [ ] **Step 1a: Create `src/request_context.ts`**

```ts
/*
|--------------------------------------------------------------------------
| RequestContext — narrow per-request scope for the XRPC executor
|--------------------------------------------------------------------------
|
| The dispatch executor receives a `RequestContext` as its second argument.
| It carries just the request-scoped primitives the executor and downstream
| handler need — not a full HttpContext.
|
| atcute's router has no per-request extension point, so both paths populate
| the same package-internal ALS (`requestContextStore`) at the dispatch
| boundary: the HTTP dispatch middleware enters it before calling
| `xrpcRouter.fetch(...)` (with a RequestContext materialized from the
| triggering HttpContext via `fromHttpContext`); the WS upgrade listener
| enters it before delegating to atcute's captured listener (with a
| RequestContext built directly from the upgrade IncomingMessage + app).
| The registered atcute closure reads `requestContextStore.getStore()` for
| either path and threads it into the executor explicitly.
|
| No synthetic HttpContext is constructed on the WS path;
| `useAsyncLocalStorage: true` in `config/app.ts` is NOT required.
*/

import { AsyncLocalStorage } from 'node:async_hooks'
import type { HttpContext, HttpRequest } from '@adonisjs/core/http'
import type { Logger } from '@adonisjs/core/logger'
import type { ContainerResolver } from '@adonisjs/core/types/container'

/**
 * The narrow per-request scope passed to the executor as `requestCtx`.
 */
export type RequestContext = {
  requestId: string
  request: HttpRequest // Adonis — surfaces on XrpcContext.request so handlers can
  // use validateUsing / input / header / completeUrl / etc.
  logger: Logger
  containerResolver: ContainerResolver
}

/**
 * Package-internal ALS that bridges the dispatch boundary (HTTP middleware
 * or WS upgrade listener) to the registered atcute closure. The executor
 * itself does NOT read from this store; it receives `requestCtx` explicitly.
 */
export const requestContextStore = new AsyncLocalStorage<RequestContext>()

/**
 * Materializes a `RequestContext` from an Adonis HttpContext. Used by the
 * HTTP-path dispatch middleware to enter `requestContextStore` before
 * calling `xrpcRouter.fetch(...)`.
 */
export function fromHttpContext(httpCtx: HttpContext): RequestContext {
  // Fall back to crypto.randomUUID() if HttpRequest.id() returns undefined
  // (consumer set `generateRequestId: false` or no x-request-id header on
  // the request) — keeps RequestContext.requestId: string invariant for
  // downstream code.
  return {
    requestId: httpCtx.request.id() ?? crypto.randomUUID(),
    request: httpCtx.request,
    logger: httpCtx.logger,
    containerResolver: httpCtx.containerResolver,
  }
}
```

- [ ] **Step 1b: Create the initial `src/xrpc_server.ts`**

```ts
/*
|--------------------------------------------------------------------------
| XRPC dispatch layer
|--------------------------------------------------------------------------
|
| Two units live here:
|
| 1. `XrpcServer` — owns the atcute `XRPCRouter` + WebSocket adapter +
|    shared executor; exposes `start()` to wire the frozen `XrpcRouter`
|    builder's routes into atcute and install the upgrade handler. Called
|    from the provider's `ready()` phase (Plan 04).
|
| 2. `createXrpcExecutor` — builds the single shared executor function
|    that atcute invokes for every route. Closure captures the route
|    registry and the serializer; error reporting (Plan 04) splices in
|    at a clearly marked seam.
|
| RequestContext + requestContextStore + fromHttpContext live in
| `./request_context.js` — both XrpcServer and XrpcDispatchMiddleware
| import from there.
*/

import type http from 'node:http'
import { ServerResponse, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { RuntimeException } from '@adonisjs/core/exceptions'
import type { ApplicationService } from '@adonisjs/core/types'
import type { Server as AdonisServer } from '@adonisjs/core/services/server'

import type { XrpcRouter, RouteInfo } from './router.js'
import type { XrpcLexicon } from './types.js'
import type { XrpcSerializer } from './serializer.js'
import { XrpcContext } from './context.js'
import { XrpcError, InternalServerError, NotFoundError } from './errors.js'
import { type RequestContext, requestContextStore } from './request_context.js'

// Forward type-only references to atcute. Imports stay type-only so this
// module's *runtime* dependency surface is just the constructor names; the
// actual `XRPCRouter` / `createNodeWebSocket` instances are constructed by
// the provider (Plan 04) and passed into `XrpcServer`'s constructor.
import type { XRPCRouter } from '@atcute/xrpc-server'
import type { createNodeWebSocket } from '@atcute/xrpc-server-node'

/**
 * The shared executor signature — one function per package instance,
 * registered with atcute for every route. The HTTP path returns a `Response`:
 * atcute's `XRPCRouter` checks `output instanceof Response` and silently
 * substitutes `new Response(null)` for non-Response returns, so the executor
 * MUST construct a Response itself — see Task 3's body for the conversion
 * from `xrpcCtx.response.state` + serialized body. The subscription path
 * returns an `AsyncIterable` of messages, which atcute iterates with
 * `for await` for frame encoding.
 */
export type SharedXrpcExecutor = (
  atcuteCtx: any, // refined to UnknownOperationContext | UnknownSubscriptionContext in Task 3
  requestCtx?: RequestContext
) => Promise<Response> | AsyncIterable<unknown>

/**
 * Dispatch orchestrator. Owns the atcute `XRPCRouter` and the WebSocket
 * helper; exposes `start()` for the provider to invoke during `ready()`.
 */
export class XrpcServer {
  #app: ApplicationService
  #router: XRPCRouter
  #ws: ReturnType<typeof createNodeWebSocket>
  #executor: SharedXrpcExecutor

  constructor(deps: {
    app: ApplicationService
    router: XRPCRouter
    ws: ReturnType<typeof createNodeWebSocket>
    executor: SharedXrpcExecutor
  }) {
    this.#app = deps.app
    this.#router = deps.router
    this.#ws = deps.ws
    this.#executor = deps.executor
  }

  /**
   * Wire the frozen builder's routes into atcute's `XRPCRouter` and install
   * the WebSocket upgrade handler. Caller must have already called
   * `router.xrpc.commit()` (provider does this in `ready()` immediately
   * before invoking `start()`).
   */
  async start(): Promise<void> {
    // Body landed in Task 5. Stub for now so the module compiles.
    throw new RuntimeException('XrpcServer.start() not yet implemented (Plan 03 Task 5)')
  }

  /** Read accessor for the dispatch middleware. */
  get router(): XRPCRouter {
    return this.#router
  }
}

/**
 * Stub. Real implementation lands in Task 3.
 */
export function createXrpcExecutor(_deps: {
  operations: ReadonlyMap<string, RouteInfo>
  serializer: XrpcSerializer
  // ERROR-REPORTING SEAM (Plan 04): `xrpc: XrpcService` field added here.
}): SharedXrpcExecutor {
  throw new RuntimeException('createXrpcExecutor() not yet implemented (Plan 03 Task 3)')
}
```

- [ ] **Step 2: Write tests for module shape**

Create `tests/xrpc_server.spec.ts`:

```ts
import { test } from '@japa/runner'
import { AsyncLocalStorage } from 'node:async_hooks'
import { XrpcServer, createXrpcExecutor } from '../src/xrpc_server.js'
import { requestContextStore, fromHttpContext } from '../src/request_context.js'

test.group('dispatch module exports', () => {
  test('xrpc_server.ts exports XrpcServer class + createXrpcExecutor factory', ({ assert }) => {
    assert.isFunction(XrpcServer, 'XrpcServer should be a class (function)')
    assert.isFunction(createXrpcExecutor, 'createXrpcExecutor should be a function')
  })

  test('request_context.ts exports requestContextStore ALS + fromHttpContext helper', ({
    assert,
  }) => {
    assert.isFunction(fromHttpContext, 'fromHttpContext should be a function')
    assert.instanceOf(requestContextStore, AsyncLocalStorage)
  })
})
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm quick:test --files tests/xrpc_server.spec.ts`
Expected: PASS — 2 tests (module shape per file). Other tests in the file land in subsequent tasks and don't exist yet.

- [ ] **Step 4: Commit**

```bash
git add src/request_context.ts src/xrpc_server.ts tests/xrpc_server.spec.ts
git commit -m "feat(xrpc): scaffold dispatch module (request_context + XrpcServer skeleton + executor stub)"
```

---

## Task 3: Implement `createXrpcExecutor` (HTTP path — procedure/query)

**Files:**

- Modify: `src/xrpc_server.ts` (replace the executor stub with the real implementation; the subscription branch lands in Task 4)
- Modify: `tests/xrpc_server.spec.ts` (add executor tests)

The executor is invoked by atcute for every dispatched route. It takes `(atcuteCtx, requestCtx)` — `requestCtx?: RequestContext` (optional in the signature; the executor throws `InternalServerError` if it's missing) arrives materialized by the registered atcute closure (which reads `requestContextStore.getStore()`); the executor itself does NOT read from any ALS. It:

1. Re-derives the NSID from the URL because atcute doesn't forward it to handlers.
2. Looks up the matching `RouteInfo` from the operations registry (Plan 01's `XrpcRouter.#normalizeHandler` already ran at register time, so `route.handler` is the pre-normalized `NormalizedHandler` shape — the executor doesn't do its own handler resolution).
3. Constructs an `XrpcContext` from `route.lexicon`, `atcuteCtx`, and `requestCtx`'s `requestId` / `logger` / `containerResolver` (no `auth` field — `XrpcContext` is auth-free in this plan).
4. Enters `XrpcContext.als` scope so downstream code can call `XrpcContext.getOrFail()`.
5. Branches on `route.handler.kind`: `'function'` → `fn(ctx)`; `'controller'` → `handle(ctx.containerResolver, ctx)`. For procedure/query, awaits the result, picks the body source (handler return value, unless `xrpcCtx.response.state.bodySet` flags an explicit `.json(...)` override), serializes via `serializer.serializeWithoutWrapping(rawBody, xrpcCtx.containerResolver)`, and constructs a `Response` from `xrpcCtx.response.state` — `Response.redirect(...)` for the redirect case, otherwise `Response.json(serialized, { status, headers })`. The Response construction is mandatory: atcute's router silently substitutes `new Response(null)` for any non-Response return. For subscription, branches to `wrapSubscriptionIterator(xrpcCtx, ...)` (Task 4) — atcute iterates the AsyncIterable separately, no Response object needed. After `xrpcCtx` is constructed, `requestCtx` doesn't surface — every request-scoped read sources from `xrpcCtx`, which mirrors the same fields.
6. On error, wraps non-`XrpcError` as `InternalServerError` and re-throws — atcute's `handleException` (configured at XRPCRouter construction in Plan 04) encodes the wire-format response.

The error-reporting seam is a comment line: Plan 04 adds `await xrpc.getRegisteredErrorHandler()?.report(err, xrpcCtx)` before the `throw`.

**Steps:**

- [ ] **Step 1: Replace the executor stub with the real implementation**

The implementation block is shown below — Step 2 contains the tests; Step 3 verifies they pass; Step 4 commits.

In `src/xrpc_server.ts`, replace the `createXrpcExecutor` stub with:

```ts
export function createXrpcExecutor(deps: {
  operations: ReadonlyMap<string, RouteInfo>
  serializer: XrpcSerializer
  // ERROR-REPORTING SEAM (Plan 04): `xrpc: XrpcService` field added here.
}): SharedXrpcExecutor {
  const { operations, serializer } = deps

  return async (atcuteCtx, requestCtx) => {
    // `requestCtx` arrives materialized — by the HTTP dispatch middleware on
    // the procedure/query path, by `#installWebSocketHandler` on the WS path.
    // The registered atcute closure reads `requestContextStore.getStore()`
    // and passes it through. No ALS read inside the executor.
    //
    // The parameter is typed optional (`requestCtx?`) so the registered
    // closure doesn't need a non-null assertion at the call site. If
    // `getStore()` returns undefined here, a dispatch boundary failed to
    // populate the store — surface a precise diagnostic instead of a
    // downstream `undefined.requestId` TypeError.
    if (!requestCtx) {
      throw new InternalServerError(
        'XRPC executor invoked without a RequestContext — the dispatch boundary failed to populate requestContextStore'
      )
    }

    // Re-derive NSID from URL — atcute parses the NSID internally for route
    // lookup but doesn't expose it on the operation context. Slice matches
    // atcute's own internal slice (`/xrpc/`.length). `operations` is a
    // `ReadonlyMap`, so `operations.get('__proto__')` returns `undefined`
    // cleanly even on a crafted URL — no prototype-pollution lookup risk.
    const nsid = new URL(atcuteCtx.request.url).pathname.slice('/xrpc/'.length)
    const route = operations.get(nsid)
    if (!route) {
      // 404 is the right wire-level response — from the client's perspective
      // there's no such XRPC method on this server. The "atcute dispatched to
      // us but the registry doesn't know it" framing is preserved as
      // diagnostic context for logs; in normal operation atcute won't dispatch
      // unregistered NSIDs to us, so seeing this in production means either a
      // registry desync or a crafted URL that snuck past atcute's matcher.
      throw new NotFoundError(`No XRPC method registered for NSID '${nsid}'`)
    }

    const xrpcCtx = new XrpcContext({
      requestId: requestCtx.requestId,
      request: requestCtx.request, // Adonis HttpRequest; atcute's Fetch Request is internal
      logger: requestCtx.logger,
      containerResolver: requestCtx.containerResolver,
      lexicon: route.lexicon,
      input: 'input' in atcuteCtx ? atcuteCtx.input : undefined,
      params: atcuteCtx.params,
      signal: atcuteCtx.signal,
    })
    // `xrpcCtx.response` is constructed inside XrpcContext's constructor —
    // XrpcStream for subscription routes (signal threaded through),
    // XrpcResponse (with default state) for procedure/query. See Plan 01's
    // src/context.ts for the branching logic.

    // `route.handler` is already the normalized form — Plan 01's
    // `XrpcRouter.#normalizeHandler` ran at register time, so eager class
    // refs went through fold's `moduleCaller` and lazy imports went through
    // `moduleImporter`. The executor just branches on `kind`.
    const invokeHandler = (ctx: XrpcContext<XrpcLexicon>): unknown =>
      route.handler.kind === 'function'
        ? route.handler.fn(ctx)
        : route.handler.handle(ctx.containerResolver, ctx)

    // HTTP path: enter the XrpcContext ALS scope and await the handler. The
    // `await` continuations re-enter the scope on each microtask boundary, so
    // downstream code calling `XrpcContext.getOrFail()` works as expected.
    //
    // Subscription path: DO NOT wrap the iterable's iteration in als.run here.
    // Async generators capture context at each `.next()` call, not at
    // construction. Returning the iterable out of `als.run` would put each
    // future `.next()` resumption in atcute's context (no store) — verified
    // empirically (Node 26). Instead, `wrapSubscriptionIterator` takes
    // `xrpcCtx` and re-enters the scope on each inner `.next()`.
    if (route.lexicon.type === 'xrpc_subscription') {
      // The handler() invocation that returns the AsyncIterable needs to run
      // inside als.run too — the handler may construct its iterator from
      // service calls that themselves read XrpcContext.
      const userIterable = XrpcContext.als.run(
        xrpcCtx,
        () => invokeHandler(xrpcCtx) as AsyncIterable<unknown>
      )
      return wrapSubscriptionIterator(userIterable, xrpcCtx, serializer)
    }

    return XrpcContext.als.run(xrpcCtx, async () => {
      try {
        const result = await invokeHandler(xrpcCtx)

        // atcute's router (verified against `xrpc-server/lib/main/router.ts`
        // on trunk, addQuery + addProcedure) inspects the handler's return
        // value with `output instanceof Response` and silently falls back to
        // `new Response(null)` for non-Response returns. We construct the
        // Response here so clients receive the actual serialized body.
        const respState = xrpcCtx.response.state

        if (respState.redirect) {
          return Response.redirect(respState.redirect.url, respState.redirect.status)
        }

        // `.json(value)` override wins over the handler's return value.
        // The handler may have called .json() and then continued doing
        // post-response work (e.g. queueing a job) before returning void —
        // `bodySet` (not `body !== undefined`) is the discriminator so
        // `.json(null)` differs from "never called".
        const rawBody = respState.bodySet ? respState.body : result
        const serialized = await serializer.serializeWithoutWrapping(
          rawBody,
          xrpcCtx.containerResolver
        )
        return Response.json(serialized, {
          status: respState.status ?? 200,
          headers: respState.headers,
        })
      } catch (err: any) {
        const xrpcError =
          err instanceof XrpcError ? err : new InternalServerError(err?.message ?? String(err))
        // ERROR-REPORTING SEAM (Plan 04): call
        //   `await xrpc.getRegisteredErrorHandler()?.report(err, xrpcCtx)`
        // here (procedure/query path). The subscription branch in Task 4 has
        // the mirror seam for `getRegisteredSubscriptionErrorHandler()`.
        throw xrpcError
      }
    })
  }
}

/** Stub. Real implementation lands in Task 4. */
async function* wrapSubscriptionIterator(
  _iterable: AsyncIterable<unknown>,
  _xrpcCtx: XrpcContext<XrpcLexicon>,
  _serializer: XrpcSerializer
): AsyncGenerator<unknown> {
  throw new RuntimeException('wrapSubscriptionIterator() not yet implemented (Plan 03 Task 4)')
}
```

- [ ] **Step 2: Write tests for the executor (HTTP procedure path)**

Append to `tests/xrpc_server.spec.ts`:

```ts
import { createXrpcExecutor } from '../src/xrpc_server.js'
import { fromHttpContext, type RequestContext } from '../src/request_context.js'
import { XrpcSerializer } from '../src/serializer.js'
import { setupApp } from './helpers.js'
import { HttpContextFactory } from '@adonisjs/core/factories/http'

// A minimal procedure lexicon for the executor tests. Tests in this file
// don't need a real atproto lexicon — we exercise the executor's dispatch
// shape, not lexicon validation (atcute does that before invoking us).
const PING_LEXICON = {
  id: 'com.example.ping',
  type: 'xrpc_procedure',
  defs: { main: { type: 'procedure', input: {}, output: {} } },
} as const

// Construct a RequestContext the same way the HTTP-path dispatch
// middleware does — `fromHttpContext(httpCtx)`. This exercises the real
// materialization helper end-to-end, catching shape drift if `HttpContext`'s
// API moves. The factory's defaults (`generateRequestId: false`, no
// `x-request-id` header) mean `requestCtx.requestId` is `undefined` here —
// tests that care about a specific request ID assert against
// `requestCtx.requestId` rather than a hardcoded string.
function makeRequestCtx(): RequestContext {
  return fromHttpContext(new HttpContextFactory().create())
}

test.group('createXrpcExecutor — HTTP procedure path', (group) => {
  group.each.setup(() => setupApp())

  test('invokes an inline handler and serializes its return value', async ({ assert, app }) => {
    let invocations = 0
    const executor = createXrpcExecutor({
      operations: new Map([
        [
          PING_LEXICON.id,
          {
            lexicon: PING_LEXICON as any,
            // Already-normalized form. In real registration, XrpcRouter.#register
            // would wrap the inline fn into this shape automatically — the test
            // bypasses the router and constructs RouteInfo directly.
            handler: {
              kind: 'function' as const,
              fn: (ctx: any) => {
                invocations++
                return { pong: true, requestId: ctx.requestId }
              },
            },
          },
        ],
      ]),
      serializer: new XrpcSerializer(),
    })

    const requestCtx = makeRequestCtx()
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.ping', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      }),
      input: {},
      params: {},
      signal: new AbortController().signal,
    }

    const response = (await executor(atcuteCtx, requestCtx)) as Response

    assert.equal(invocations, 1, 'inline handler called exactly once')
    assert.instanceOf(response, Response)
    assert.equal(response.status, 200, 'default status is 200 when handler does not set one')
    assert.equal(response.headers.get('content-type'), 'application/json')
    // requestCtx.requestId is undefined here (HttpContextFactory defaults
    // `generateRequestId: false` and provides no `x-request-id` header) —
    // assert against the materialized value rather than a hardcoded string.
    const body = await response.json()
    assert.deepEqual(body, { pong: true, requestId: requestCtx.requestId })
  })

  test('honors status / header / json overrides set via ctx.response', async ({ assert, app }) => {
    const executor = createXrpcExecutor({
      operations: new Map([
        [
          PING_LEXICON.id,
          {
            lexicon: PING_LEXICON as any,
            handler: {
              kind: 'function' as const,
              fn: (ctx: any) => {
                ctx.response.status(201).header('etag', 'W/"abc"').json({ created: true })
                // handler returns undefined — explicit json() override is what
                // the executor uses as the body
              },
            },
          },
        ],
      ]),
      serializer: new XrpcSerializer(),
    })

    const requestCtx = makeRequestCtx()
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
      input: {},
      params: {},
      signal: new AbortController().signal,
    }

    const response = (await executor(atcuteCtx, requestCtx)) as Response

    assert.equal(response.status, 201)
    assert.equal(response.headers.get('etag'), 'W/"abc"')
    assert.deepEqual(await response.json(), { created: true })
  })

  test('redirect via ctx.response.redirect(url, status) returns a 3xx Response', async ({
    assert,
    app,
  }) => {
    const executor = createXrpcExecutor({
      operations: new Map([
        [
          PING_LEXICON.id,
          {
            lexicon: PING_LEXICON as any,
            handler: {
              kind: 'function' as const,
              fn: (ctx: any) => ctx.response.redirect('https://cdn.example/blob/abc', 302),
            },
          },
        ],
      ]),
      serializer: new XrpcSerializer(),
    })

    const requestCtx = makeRequestCtx()
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
      input: {},
      params: {},
      signal: new AbortController().signal,
    }

    const response = (await executor(atcuteCtx, requestCtx)) as Response

    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), 'https://cdn.example/blob/abc')
  })

  test('wraps a non-XrpcError as InternalServerError', async ({ assert, app }) => {
    const executor = createXrpcExecutor({
      operations: new Map([
        [
          PING_LEXICON.id,
          {
            lexicon: PING_LEXICON as any,
            handler: {
              kind: 'function' as const,
              fn: () => {
                throw new Error('boom from handler')
              },
            },
          },
        ],
      ]),
      serializer: new XrpcSerializer(),
    })

    const requestCtx = makeRequestCtx()
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
      input: {},
      params: {},
      signal: new AbortController().signal,
    }

    await assert.rejects(async () => executor(atcuteCtx, requestCtx), /boom from handler/)
    // And the rejection should be InternalServerError (status 500, errorName InternalServerError)
    try {
      await executor(atcuteCtx, requestCtx)
    } catch (err: any) {
      assert.equal(err.constructor.name, 'InternalServerError')
      assert.equal(err.errorName, 'InternalServerError')
    }
  })

  test('passes XrpcError through without re-wrapping', async ({ assert, app }) => {
    const { InvalidRequestError } = await import('../src/errors.js')
    const executor = createXrpcExecutor({
      operations: new Map([
        [
          PING_LEXICON.id,
          {
            lexicon: PING_LEXICON as any,
            handler: {
              kind: 'function' as const,
              fn: () => {
                throw new InvalidRequestError('reason unrecognized')
              },
            },
          },
        ],
      ]),
      serializer: new XrpcSerializer(),
    })

    const requestCtx = makeRequestCtx()
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
      input: {},
      params: {},
      signal: new AbortController().signal,
    }

    try {
      await executor(atcuteCtx, requestCtx)
      assert.fail('executor should have thrown')
    } catch (err: any) {
      assert.equal(err.constructor.name, 'InvalidRequestError')
      assert.equal(err.errorName, 'InvalidRequest')
    }
  })

  test('throws NotFoundError when no route matches the NSID', async ({ assert, app }) => {
    const executor = createXrpcExecutor({
      operations: new Map(), // no routes
      serializer: new XrpcSerializer(),
    })

    const requestCtx = makeRequestCtx()
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.unknown', { method: 'POST' }),
      input: {},
      params: {},
      signal: new AbortController().signal,
    }

    try {
      await executor(atcuteCtx, requestCtx)
      assert.fail('executor should have thrown')
    } catch (err: any) {
      assert.equal(err.constructor.name, 'NotFoundError')
      assert.equal(err.errorName, 'NotFound')
      assert.match(err.message, /no xrpc method registered/i)
    }
  })

  test('crafted `/xrpc/__proto__` request gets NotFoundError, not a prototype-lookup hit', async ({
    assert,
    app,
  }) => {
    // The Map-backed operations is what makes this safe — Map.get('__proto__')
    // returns undefined cleanly, where obj['__proto__'] would have returned
    // Object.prototype (truthy, would have bypassed the `if (!route)` guard
    // and then crashed on `route.lexicon.type` with a confusing TypeError).
    const executor = createXrpcExecutor({
      operations: new Map(),
      serializer: new XrpcSerializer(),
    })
    const requestCtx = makeRequestCtx()
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/__proto__', { method: 'POST' }),
      input: {},
      params: {},
      signal: new AbortController().signal,
    }
    try {
      await executor(atcuteCtx, requestCtx)
      assert.fail('executor should have thrown')
    } catch (err: any) {
      assert.equal(err.constructor.name, 'NotFoundError')
    }
  })

  test('throws InternalServerError when invoked without a RequestContext', async ({
    assert,
    app,
  }) => {
    // The registered atcute closure passes `requestContextStore.getStore()`
    // through unconditionally. If a dispatch boundary ever fails to populate
    // the store, the executor's optional parameter is undefined and the
    // executor surfaces a precise diagnostic. This test pins that contract.
    const executor = createXrpcExecutor({
      operations: new Map([
        [
          PING_LEXICON.id,
          {
            lexicon: PING_LEXICON as any,
            handler: { kind: 'function' as const, fn: () => ({ ok: true }) },
          },
        ],
      ]),
      serializer: new XrpcSerializer(),
    })
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.ping', { method: 'POST' }),
      input: {},
      params: {},
      signal: new AbortController().signal,
    }

    try {
      await executor(atcuteCtx) // second arg omitted on purpose
      assert.fail('executor should have thrown')
    } catch (err: any) {
      assert.equal(err.constructor.name, 'InternalServerError')
      assert.match(err.message, /without a RequestContext/i)
    }
  })
})
```

**Why pass `requestCtx` directly and skip ALS plumbing**: the executor takes `requestCtx` as an explicit parameter — the dispatch boundary (HTTP middleware or WS upgrade listener) is what enters `requestContextStore`; the registered atcute closure reads from it; the executor itself never touches the ALS. Unit tests skip the boundary entirely and pass a `RequestContext` built via `fromHttpContext(new HttpContextFactory().create())` — same materialization helper the production HTTP path uses, so unit tests catch any drift in the helper's shape. This also avoids the previous need to populate Adonis's private HttpContext ALS for tests (verified against `@adonisjs/http-server@8.x` source — there's no public method to enter that ALS from outside). The production HTTP path is additionally covered by Task 8's `light-my-request` integration test, which fires real requests through the Adonis pipeline so the dispatch middleware materializes a `RequestContext` from a real (not factory-built) `HttpContext`.

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm quick:test --files tests/xrpc_server.spec.ts`
Expected: PASS — 7 new tests (HTTP path: pong + status/header/json overrides + redirect + non-XrpcError wrap + XrpcError pass-through + NotFound + crafted `/xrpc/__proto__` + missing-RequestContext guard — verify the actual count after writing the tests) plus the 2 module-shape tests from Task 2.

- [ ] **Step 4: Commit**

```bash
git add src/xrpc_server.ts tests/xrpc_server.spec.ts
git commit -m "feat(xrpc): implement createXrpcExecutor HTTP path (procedure/query)"
```

---

## Task 4: Implement `wrapSubscriptionIterator` (subscription branch)

**Files:**

- Modify: `src/xrpc_server.ts` (replace the `wrapSubscriptionIterator` stub with the real implementation)
- Modify: `tests/xrpc_server.spec.ts` (add subscription tests)

The subscription branch wraps the user's async-generator handler with a transforming generator that (a) re-enters the `XrpcContext.als` scope on every inner `.next()` call so downstream code calling `XrpcContext.getOrFail()` from inside yields sees the right context, and (b) serializes each yielded message before atcute encodes it as a CBOR frame. On error, the wrapper translates `XrpcError` → `XRPCSubscriptionError` so atcute's `handleSubscriptionException` hook (configured at XRPCRouter construction in Plan 04) emits the error frame and closes the stream.

**Why the per-`.next()` ALS re-entry matters** — verified with a Node-24 spike: async generators capture their ALS context at each `.next()` call, NOT at construction. A `XrpcContext.als.run(xrpcCtx, () => handler())` that just constructs the iterator inside scope and returns it doesn't propagate the store to subsequent `.next()` resumptions — those run in atcute's iteration context (no store). The fix is for `wrapSubscriptionIterator` to drive each inner `.next()` from inside `XrpcContext.als.run(xrpcCtx, ...)`. (Spike was a 20-line throwaway; preserved as a comment-only commit memo rather than checked into `tests/` since it has no recurring assertions. Reproduce with `als.run(ctx, () => async-generator())` returning the iterator and observing `als.getStore()` inside the body — `undefined` on every yield after the first.)

**Steps:**

- [ ] **Step 1: Replace the `wrapSubscriptionIterator` stub with the real implementation**

In `src/xrpc_server.ts`, replace the stub with:

```ts
import { XRPCSubscriptionError } from '@atcute/xrpc-server'

/**
 * Wraps a user-provided async-generator subscription handler with a
 * transforming generator that:
 *
 * 1. Re-enters the `XrpcContext.als` scope on every inner `.next()` call so
 *    downstream code calling `XrpcContext.getOrFail()` from inside yields
 *    sees the current context. Async generators capture context at `.next()`
 *    time (NOT at construction); a one-shot `als.run` around iterator
 *    construction doesn't propagate.
 * 2. Pipes each yielded value through the XRPC serializer (so transformer
 *    contracts the user embedded — `Item` / `Collection` — get unpacked
 *    before atcute's framing layer encodes the message as a CBOR frame).
 *
 * On error, `XrpcError` instances are translated to `XRPCSubscriptionError`
 * so atcute's `handleSubscriptionException` hook emits the error frame and
 * closes the stream cleanly.
 */
async function* wrapSubscriptionIterator(
  iterable: AsyncIterable<unknown>,
  xrpcCtx: XrpcContext<XrpcLexicon>,
  serializer: XrpcSerializer
): AsyncGenerator<unknown> {
  // Only needs xrpcCtx — containerResolver (for serialization) and the full
  // context (for the error reporter) both live on XrpcContext.
  const inner = iterable[Symbol.asyncIterator]()
  try {
    while (true) {
      // Each .next() runs inside the XrpcContext ALS scope. The user's
      // generator body resumes inside this scope and any downstream
      // `XrpcContext.getOrFail()` call sees `xrpcCtx`. Verified
      // empirically — see Task 4 intro for the spike.
      const result = await XrpcContext.als.run(xrpcCtx, () => inner.next())
      if (result.done) return
      // Serialization doesn't need to read XrpcContext via the ALS, so it
      // stays outside the scope — keeps the scope window tight to just
      // handler execution.
      yield await serializer.serializeWithoutWrapping(result.value, xrpcCtx.containerResolver)
    }
  } catch (err: any) {
    const xrpcError =
      err instanceof XrpcError
        ? err
        : new InternalServerError(err?.message ?? String(err), { cause: err })
    // ERROR-REPORTING SEAM (Plan 04): call
    //   `await xrpc.getRegisteredSubscriptionErrorHandler()?.report(err, xrpcCtx)`
    // here. Falls through to `getRegisteredErrorHandler()` when the
    // subscription-specific handler isn't registered.
    throw new XRPCSubscriptionError({
      error: xrpcError.errorName,
      message: xrpcError.message,
    })
  }
}
```

(`XRPCSubscriptionError` wasn't imported in Task 2 — Task 4's snippet adds the value import at the top of `src/xrpc_server.ts`. Place it alongside the other `@atcute/xrpc-server` imports rather than inline at the function site.)

- [ ] **Step 2: Write tests for the subscription branch**

Append to `tests/xrpc_server.spec.ts`:

```ts
test.group('createXrpcExecutor — subscription path', (group) => {
  group.each.setup(() => setupApp())

  const SUB_LEXICON = {
    id: 'com.example.stream',
    type: 'xrpc_subscription',
    defs: {
      main: {
        type: 'subscription',
        message: { schema: { type: 'union', refs: ['#tick'] } },
      },
      tick: { type: 'object', properties: { n: { type: 'integer' } } },
    },
  } as const

  test('wraps an async-generator handler and yields serialized messages', async ({
    assert,
    app,
  }) => {
    const executor = createXrpcExecutor({
      operations: new Map([
        [
          SUB_LEXICON.id,
          {
            lexicon: SUB_LEXICON as any,
            handler: {
              kind: 'function' as const,
              fn: async function* (_ctx: any) {
                yield { $type: 'com.example.stream#tick', n: 1 }
                yield { $type: 'com.example.stream#tick', n: 2 }
                yield { $type: 'com.example.stream#tick', n: 3 }
              },
            },
          },
        ],
      ]),
      serializer: new XrpcSerializer(),
    })

    const requestCtx = makeRequestCtx()
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.stream'),
      params: {},
      signal: new AbortController().signal,
    }

    const iterable = (await executor(atcuteCtx, requestCtx)) as AsyncIterable<any>
    const collected: any[] = []
    for await (const msg of iterable) {
      collected.push(msg)
    }

    assert.lengthOf(collected, 3)
    assert.equal(collected[0].n, 1)
    assert.equal(collected[2].n, 3)
  })

  test('XrpcContext.als is in scope during each yielded value (per-.next() ALS re-entry)', async ({
    assert,
    app,
  }) => {
    // The whole reason wrapSubscriptionIterator takes xrpcCtx as a parameter
    // and wraps each inner .next() in XrpcContext.als.run: async generators
    // capture their ALS context at .next() time, not at construction. If we
    // ever regress to a one-shot als.run around iterator construction, this
    // test fails — the handler body's getOrFail() calls return undefined.
    const observed: ({ has: true; nsid: string } | { has: false })[] = []
    const executor = createXrpcExecutor({
      operations: new Map([
        [
          SUB_LEXICON.id,
          {
            lexicon: SUB_LEXICON as any,
            handler: {
              kind: 'function' as const,
              fn: async function* (_ctx: any) {
                for (let n = 1; n <= 3; n++) {
                  const fromAls = XrpcContext.als.getStore()
                  observed.push(fromAls ? { has: true, nsid: fromAls.lexicon.id } : { has: false })
                  yield { $type: 'com.example.stream#tick', n }
                }
              },
            },
          },
        ],
      ]),
      serializer: new XrpcSerializer(),
    })

    const requestCtx = makeRequestCtx()
    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.stream'),
      params: {},
      signal: new AbortController().signal,
    }

    const iterable = (await executor(atcuteCtx, requestCtx)) as AsyncIterable<any>
    for await (const _ of iterable) {
      /* drain */
    }

    assert.lengthOf(observed, 3)
    for (const entry of observed) {
      assert.isTrue(entry.has, 'XrpcContext.als.getStore() should be defined on each yield')
      assert.equal((entry as any).nsid, 'com.example.stream')
    }
  })

  test('translates XrpcError thrown from a subscription handler to XRPCSubscriptionError', async ({
    assert,
    app,
  }) => {
    const { InvalidRequestError } = await import('../src/errors.js')
    const { XRPCSubscriptionError } = await import('@atcute/xrpc-server')

    const executor = createXrpcExecutor({
      operations: new Map([
        [
          SUB_LEXICON.id,
          {
            lexicon: SUB_LEXICON as any,
            handler: {
              kind: 'function' as const,
              fn: async function* (_ctx: any) {
                yield { $type: 'com.example.stream#tick', n: 1 }
                throw new InvalidRequestError('cursor is from the future')
              },
            },
          },
        ],
      ]),
      serializer: new XrpcSerializer(),
    })

    const requestCtx = makeRequestCtx()

    const atcuteCtx = {
      request: new Request('http://localhost/xrpc/com.example.stream'),
      params: {},
      signal: new AbortController().signal,
    }

    const iterable = (await executor(atcuteCtx, requestCtx)) as AsyncIterable<any>
    const collected: any[] = []
    try {
      for await (const msg of iterable) {
        collected.push(msg)
      }
      assert.fail('iterable should have thrown')
    } catch (err: any) {
      assert.instanceOf(err, XRPCSubscriptionError)
      assert.equal(err.error, 'InvalidRequest') // mapped from XrpcError.errorName
      assert.match(err.message, /cursor is from the future/)
    }

    assert.lengthOf(collected, 1, 'first message yielded before the throw')
  })
})
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm quick:test --files tests/xrpc_server.spec.ts`
Expected: PASS — all tests from Tasks 2, 3, and now 4. The `XRPCSubscriptionError` constructor signature is `{ error, message }` per the spec (and matches Plan 04's usage); the assertion above reads `err.error`. If atcute's source disagrees at implementation time, fix the throw + assertion together and update both this plan and Plan 04's matching call site.

- [ ] **Step 4: Commit**

```bash
git add src/xrpc_server.ts tests/xrpc_server.spec.ts
git commit -m "feat(xrpc): implement wrapSubscriptionIterator (subscription branch + error translation)"
```

---

## Task 5: Implement `XrpcServer.start()` and `#installRoutes`

**Files:**

- Modify: `src/xrpc_server.ts` (replace `start()` body; add `#installRoutes` method)
- Modify: `tests/xrpc_server.spec.ts` (add `XrpcServer` tests)

`start()` acquires the Adonis router + appServer + nodeServer from the container, calls `#installRoutes` to fan the committed `XrpcRouter` builder's routes into atcute's `XRPCRouter`, and calls `#installWebSocketHandler` (Task 6). For unit testing in this task, we exercise `#installRoutes` via a mocked `XRPCRouter` (atcute's class is straightforward to stub — we just observe which `add*` methods get called).

**Steps:**

- [ ] **Step 1: Implement `#installRoutes` and update `start()`**

In `src/xrpc_server.ts`, replace the `XrpcServer.start()` body and add the private `#installRoutes` method (and the test-only `installRoutesForTesting` shim):

```ts
async start(): Promise<void> {
  // No `useAsyncLocalStorage: true` check — the package brings its own
  // `requestContextStore` ALS, entered by the HTTP dispatch middleware and the
  // WS upgrade listener at the dispatch boundary. We don't depend on
  // Adonis's HttpContext ALS for any read inside the executor.

  // Routes install unconditionally — registering routes on atcute's
  // XRPCRouter has no dependency on a Node HTTP server (the HTTP-side
  // dispatch flows through Adonis's middleware pipeline, which doesn't
  // care whether the server is bound to a port). Only the WebSocket
  // upgrade handler (Task 6) genuinely needs a node server.
  const router = await this.#app.container.make('router')
  this.#installRoutes(router.xrpc)
  // WebSocket upgrade handler lands in Task 6.
}

#installRoutes(xrpc: XrpcRouter): void {
  if (!xrpc.committed) {
    throw new RuntimeException(
      'XRPC builder must be committed before installing routes; call router.xrpc.commit() first'
    )
  }

  // One closure handler for all routes. atcute has no per-request extension
  // point; both paths bridge through `requestContextStore` (HTTP via the
  // dispatch middleware, WS via the upgrade listener), so the registered
  // handler just reads from it and passes the result through. The executor's
  // signature accepts `requestCtx?: RequestContext`; if `getStore()` returns
  // undefined here (i.e. a dispatch boundary skipped its `enterWith` /
  // `run`), the executor throws InternalServerError with a clear diagnostic
  // — no non-null assertion needed at this call site.
  const handler = (atcuteCtx: any) =>
    this.#executor(atcuteCtx, requestContextStore.getStore())

  for (const route of xrpc.operations.values()) {
    switch (route.lexicon.type) {
      case 'xrpc_procedure':
        this.#router.addProcedure(route.lexicon as any, { handler })
        break
      case 'xrpc_query':
        this.#router.addQuery(route.lexicon as any, { handler })
        break
      case 'xrpc_subscription':
        this.#router.addSubscription(route.lexicon as any, { handler })
        break
      default: {
        // Exhaustiveness — if the lexicon shape adds a new method type
        // (unlikely; the spec hasn't changed in years), this surfaces a
        // type error at compile time so we catch it before runtime.
        const _exhaustive: never = route.lexicon.type
        throw new InternalServerError(
          `Unhandled XRPC lexicon type at install: ${String(_exhaustive)}`
        )
      }
    }
  }
}

/**
 * @internal — test-only escape hatch for unit-testing `#installRoutes`
 * without needing a real container-bound Adonis router. Production code
 * goes through `start()`.
 */
installRoutesForTesting(xrpc: XrpcRouter): void {
  this.#installRoutes(xrpc)
}
```

- [ ] **Step 2: Write tests for route installation**

Append to `tests/xrpc_server.spec.ts`:

```ts
import { XrpcServer } from '../src/xrpc_server.js'
import { XrpcRouter } from '../src/router.js'

test.group('XrpcServer.#installRoutes', (group) => {
  group.each.setup(() => setupApp())

  test('refuses to install routes if the XrpcRouter builder is not committed', async ({
    assert,
    app,
  }) => {
    const xrpc = new XrpcRouter(app)
    xrpc.procedure(PING_LEXICON as any, () => ({ ok: true }))
    // Note: NOT calling xrpc.commit()

    const mockAtcuteRouter = makeMockAtcuteRouter()
    const mockWs = makeMockWs()
    const xrpcServer = new XrpcServer({
      app,
      router: mockAtcuteRouter as any,
      ws: mockWs as any,
      executor: (() => undefined) as any,
    })

    // Calling the private method indirectly via start() — but start() also
    // does container.make('router'), which requires the router getter to be
    // installed by the provider (Plan 04). For this test, we exercise the
    // route-install logic in isolation via a test-only escape hatch: the
    // class exposes a tiny package-internal method we can use.
    await assert.rejects(
      async () => (xrpcServer as any).installRoutesForTesting(xrpc),
      /must be committed/
    )
  })

  test('dispatches procedure/query/subscription to the matching atcute add* method', async ({
    assert,
    app,
  }) => {
    const PROC = { id: 'com.example.proc', type: 'xrpc_procedure', defs: { main: {} } } as const
    const QUERY = { id: 'com.example.query', type: 'xrpc_query', defs: { main: {} } } as const
    const SUB = { id: 'com.example.sub', type: 'xrpc_subscription', defs: { main: {} } } as const

    const xrpc = new XrpcRouter(app)
    xrpc.procedure(PROC as any, () => ({ ok: true }))
    xrpc.query(QUERY as any, () => ({ ok: true }))
    xrpc.subscription(SUB as any, async function* () {
      yield {}
    })
    xrpc.commit()

    const mockAtcuteRouter = makeMockAtcuteRouter()
    const mockWs = makeMockWs()
    const sharedExecutor = (() => undefined) as any
    const xrpcServer = new XrpcServer({
      app,
      router: mockAtcuteRouter as any,
      ws: mockWs as any,
      executor: sharedExecutor,
    })

    ;(xrpcServer as any).installRoutesForTesting(xrpc)

    assert.lengthOf(mockAtcuteRouter.addProcedureCalls, 1)
    assert.lengthOf(mockAtcuteRouter.addQueryCalls, 1)
    assert.lengthOf(mockAtcuteRouter.addSubscriptionCalls, 1)
    assert.equal(mockAtcuteRouter.addProcedureCalls[0].lexicon.id, 'com.example.proc')
    assert.equal(mockAtcuteRouter.addQueryCalls[0].lexicon.id, 'com.example.query')
    assert.equal(mockAtcuteRouter.addSubscriptionCalls[0].lexicon.id, 'com.example.sub')

    // All three should have received the same shared executor instance —
    // verifying the closure-deduplication design.
    assert.strictEqual(mockAtcuteRouter.addProcedureCalls[0].opts.handler, sharedExecutor)
    assert.strictEqual(mockAtcuteRouter.addQueryCalls[0].opts.handler, sharedExecutor)
    assert.strictEqual(mockAtcuteRouter.addSubscriptionCalls[0].opts.handler, sharedExecutor)
  })
})

function makeMockAtcuteRouter() {
  const addProcedureCalls: { lexicon: any; opts: any }[] = []
  const addQueryCalls: { lexicon: any; opts: any }[] = []
  const addSubscriptionCalls: { lexicon: any; opts: any }[] = []
  return {
    addProcedureCalls,
    addQueryCalls,
    addSubscriptionCalls,
    addProcedure(lexicon: any, opts: any) {
      addProcedureCalls.push({ lexicon, opts })
    },
    addQuery(lexicon: any, opts: any) {
      addQueryCalls.push({ lexicon, opts })
    },
    addSubscription(lexicon: any, opts: any) {
      addSubscriptionCalls.push({ lexicon, opts })
    },
  }
}

function makeMockWs() {
  return {
    adapter: {},
    injectWebSocket: () => {},
  }
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm quick:test --files tests/xrpc_server.spec.ts`
Expected: PASS — all tests from prior tasks plus 2 new tests in this task.

- [ ] **Step 4: Commit**

```bash
git add src/xrpc_server.ts tests/xrpc_server.spec.ts
git commit -m "feat(xrpc): implement XrpcServer.start() + #installRoutes (HTTP route registration)"
```

---

## Task 6: Implement `XrpcServer.#installWebSocketHandler`

**Files:**

- Modify: `src/xrpc_server.ts` (add `#installWebSocketHandler`; wire it into `start()`)

The WebSocket upgrade handler is the trickiest piece of the dispatch layer. The Node server's `'upgrade'` event fires synchronously when a client sends `Upgrade: websocket`. The naive design ("our listener registered first; atcute's registered second; ours sets the ALS, atcute's inherits it") had a fatal flaw: **atcute's `injectWebSocket` listener doesn't filter by URL prefix** — it dispatches every upgrade through `router.fetch` and `socket.end()`s the response for non-matches. That breaks every non-XRPC WebSocket endpoint on the same Node server, including **Vite HMR in dev** (which AdonisJS's Vite integration relies on for client-side hot reload). The dev workflow regression is the blocker here; the same problem would also hit any app-defined WS endpoint (`/ws/notifications`, etc.).

**The fix: snip-and-wrap.** We call `injectWebSocket` to let atcute register its listener, then immediately remove it from `nodeServer.listeners('upgrade')` and re-register a wrapping listener of our own that:

1. Returns early if the URL doesn't start with `/xrpc/` — letting Vite HMR and any other consumer-registered upgrade listener handle the event untouched.
2. For `/xrpc/*` URLs, builds a `RequestContext` directly from the upgrade `IncomingMessage` and `app`: construct an Adonis `HttpRequest` via `appServer.createRequest(req, synthRes)` (uses live app config, so `.id()` honors `generateRequestId` / `createRequestId` for parity with the HTTP path's generator) and keep the HttpRequest in the RequestContext so subscription handlers can use `ctx.request.header()` / `ctx.request.input()` / `.completeUrl()` etc.; logger via `app.logger.child({ request_id })`; resolver via `app.container.createResolver()`. `enterWith()` the result on `requestContextStore`, then call atcute's captured listener. No synthetic `HttpContext` is constructed.

This collapses to a single registered listener on the Node server (ours, wrapping atcute's). No ordering invariant to maintain; no race between our listener and atcute's; non-XRPC upgrades pass through cleanly.

**Brittleness vs. the previous design**: we trade "depends on atcute using additive `.on('upgrade', ...)`" (the previous invariant) for "depends on atcute's `injectWebSocket` adding exactly one upgrade listener." The new invariant is testable at runtime — we snapshot `listenerCount('upgrade')` before and after the `injectWebSocket` call and throw a clear `RuntimeException` if the diff isn't 1.

**TODO (upstream)**: this snip-and-wrap dance exists because atcute doesn't expose a URL predicate. A small PR to `@atcute/xrpc-server-node` adding `createNodeWebSocket({ urlPredicate: (req) => boolean })` would let consumers (including us) co-host non-XRPC WS endpoints natively, and our `#installWebSocketHandler` would simplify to a single `injectWebSocket` call with `urlPredicate: (req) => req.url?.startsWith('/xrpc/')`. Tracking issue: file against `mary-ext/atcute` after Plan 03 ships.

**`enterWith()` (not `run()`) is intentional**: we want the store to persist for the rest of the synchronous chain (atcute's wrapped listener fires next), then propagate into async continuations.

**Concurrent-upgrade safety is empirically verified, not just hoped for.** A reasonable concern is: if two `'upgrade'` events fire on the same I/O callback (multiple clients handshaking simultaneously), the second `enterWith(ctxB)` would mutate the current resource's store after the first `enterWith(ctxA)` — would async work scheduled during emit-A then resume with ctxB? A Node-24 spike confirmed: **no**. When the wrapped listener schedules async work (via `await` / `setTimeout` / `process.nextTick`), Node's async-hooks `init` hook captures the current ALS store at scheduling time and binds it to the new async resource. Later `enterWith` calls mutate the current resource's store but don't retroactively rewrite previously-created resources' stores. So emit-A's microtasks restore ctxA correctly even after emit-B's `enterWith(ctxB)` has executed. The "persists the store through any following asynchronous calls" wording in the Node docs is doing the work — _following_ is the key word; it's not retroactive. (Reproduce by emitting two `'upgrade'` events in the same tick from a `nodeServer.emit('upgrade', ...)` pair, each `enterWith`-ing a distinct context, with each handler awaiting `setImmediate` and then logging `als.getStore()` — both log their own context.)

**Steps:**

- [ ] **Step 1: Add the `#installWebSocketHandler` method**

In `src/xrpc_server.ts`, add after `#installRoutes`:

```ts
/**
 * Install the Node server 'upgrade' listener for the XRPC subscription
 * dispatch path. Snips atcute's auto-registered listener and re-registers
 * a URL-filtering wrapper so non-XRPC upgrades (Vite HMR, app-defined WS
 * endpoints) pass through to other listeners untouched.
 */
#installWebSocketHandler(nodeServer: http.Server, appServer: AdonisServer): void {
  // Let atcute register its 'upgrade' listener, then capture it and
  // immediately remove it. We verify the listener-count delta is exactly 1
  // so we fail loudly if atcute's internals change (e.g. registers multiple
  // listeners or uses `prependListener`). See the Task 6 intro for the
  // upstream-PR todo that would eliminate this dance.
  const beforeCount = nodeServer.listenerCount('upgrade')
  this.#ws.injectWebSocket(nodeServer, this.#router)
  const upgradeListeners = nodeServer.listeners('upgrade')
  const addedCount = upgradeListeners.length - beforeCount
  const atcuteListener = upgradeListeners.at(-1) as any
  if (addedCount !== 1 || typeof atcuteListener !== 'function') {
    throw new RuntimeException(
      `@atcute/xrpc-server-node.injectWebSocket added ${addedCount} upgrade listeners (expected 1); the snip-and-wrap design in XrpcServer.#installWebSocketHandler needs updating.`
    )
  }
  nodeServer.removeListener('upgrade', atcuteListener)

  // Single wrapping listener. Non-XRPC upgrades fall through to other
  // listeners (Vite HMR, app-defined WS) without us touching the socket.
  nodeServer.on('upgrade', async (req, socket, head) => {
    if (!req.url?.startsWith('/xrpc/')) {
      // Not ours — let other 'upgrade' listeners handle. Critically, this
      // is the path Vite HMR's WebSocket upgrade takes in dev mode.
      //
      // Trade-off: because we snipped atcute's catch-all listener, a
      // non-XRPC upgrade with NO consumer-registered listener falls through
      // to Node's default behavior (destroy the socket) rather than getting
      // an explicit 404 like atcute used to send. Acceptable: the only
      // reason atcute's 404 was nice was that it handled everything; with
      // proper consumer routing (Vite, app WS), this branch is never the
      // last resort.
      return
    }

    // Build a narrow RequestContext directly — no synthetic HttpContext.
    // appServer.createRequest uses the live app config (encryption, qsParser,
    // HTTP config) so HttpRequest.id() respects the consumer's
    // `generateRequestId` / `createRequestId` settings — request IDs stay
    // consistent with the HTTP-path generator within the same app. The
    // HttpRequest itself flows into the RequestContext so subscription
    // handlers can use `ctx.request.header(...)`, `ctx.request.input(...)`
    // (query params), `ctx.request.completeUrl()`, etc. — same surface as
    // procedure/query handlers. Body methods are inapplicable (subscriptions
    // have no body) but consistent with the lexicon contract.
    const synthRes = new ServerResponse(req)
    const request = appServer.createRequest(req, synthRes)
    // Same fallback as `fromHttpContext` — keeps `RequestContext.requestId`
    // always a string regardless of consumer's `generateRequestId` setting.
    const requestId = request.id() ?? crypto.randomUUID()
    const logger = this.#app.logger.child({ request_id: requestId })
    const containerResolver = this.#app.container.createResolver()

    // `enterWith` (not `run`) so the store survives the synchronous chain
    // when we delegate to atcute's captured listener (which awaits async
    // work in router.fetch — those continuations inherit our store via
    // async-hooks init snapshotting). See the Task 6 intro for the
    // concurrent-upgrade safety analysis.
    requestContextStore.enterWith({ requestId, request, logger, containerResolver })

    await atcuteListener(req, socket, head)
  })
}
```

And update `start()` to call it:

```ts
async start(): Promise<void> {

  // Routes always install — no dependency on a Node HTTP server.
  const router = await this.#app.container.make('router')
  this.#installRoutes(router.xrpc)

  // WebSocket upgrade handler only installs when a Node HTTP server is
  // attached. In tests that use `light-my-request` (no port binding) and
  // in `console` / `ace` environments, `getNodeServer()` returns
  // undefined — HTTP dispatch still works through Adonis's middleware,
  // and there's just nothing to upgrade.
  const appServer = await this.#app.container.make('server')
  const nodeServer = appServer.getNodeServer()
  if (!nodeServer) return
  this.#installWebSocketHandler(nodeServer, appServer)
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: zero errors. (The functional WS test in Task 10 exercises this end-to-end via `injectXrpcSubscription`'s synthetic `nodeServer.emit('upgrade')`; unit-testing `#installWebSocketHandler` in isolation is messy because the snip-and-wrap invariant only matters with a real upgrade emit on a Node server.)

- [ ] **Step 3: Commit**

```bash
git add src/xrpc_server.ts
git commit -m "feat(xrpc): install WebSocket upgrade handler in XrpcServer.start()"
```

---

## Task 7: Implement `XrpcDispatchMiddleware`

**Files:**

- Create: `src/middleware/dispatch.ts`
- Create: `tests/middleware/dispatch.spec.ts`

Server-level middleware mounted in `start/kernel.ts`'s `server.use([...])` chain. Short-circuits on `/xrpc/*` paths by handing the request to atcute's `XRPCRouter.fetch()` and writing the response back to Adonis. Non-matching paths fall through to the next middleware. The middleware needs the `XRPCRouter` instance — Plan 04 will container-bind it; for now the middleware reads from a known binding key.

**Steps:**

- [ ] **Step 1: Implement `src/middleware/dispatch.ts`**

Create `src/middleware/dispatch.ts`:

```ts
import { RuntimeException } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

import { XrpcServer } from '../xrpc_server.js'
import { requestContextStore, fromHttpContext } from '../request_context.js'
import { adonisRequestToWebRequest, writeWebResponseToAdonisResponse } from '../utils.js'

/**
 * Server-level middleware mounted in `start/kernel.ts`'s `server.use([...])`
 * chain. Intercepts `/xrpc/*` requests and dispatches them through atcute's
 * `XRPCRouter`. Non-matching paths fall through to the next middleware.
 *
 * The middleware resolves `XrpcServer` from the per-request container (the
 * provider in Plan 04 binds it as a singleton — same instance on every
 * request). Resolving per-request lets future plans inject a per-test or
 * per-tenant XrpcServer via container scoping; in production it's always
 * the same singleton.
 *
 * The middleware is also the HTTP-path entry into `requestContextStore`: it
 * materializes a `RequestContext` from the triggering `HttpContext`
 * (via `fromHttpContext(ctx)`) and runs `xrpcRouter.fetch(...)` inside
 * `requestContextStore.run(...)`. The registered atcute closure then reads
 * `requestContextStore.getStore()` and threads it into the executor.
 */
export default class XrpcDispatchMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (!ctx.request.url().startsWith('/xrpc/')) {
      return next()
    }

    let xrpcServer: XrpcServer
    try {
      xrpcServer = await ctx.containerResolver.make(XrpcServer)
    } catch (err) {
      throw new RuntimeException(
        'XrpcServer is not bound in the container — provider may not have booted (Plan 04 wires this)',
        { cause: err as Error }
      )
    }

    const webRequest = adonisRequestToWebRequest(ctx.request)
    const webResponse = await requestContextStore.run(fromHttpContext(ctx), () =>
      xrpcServer.router.fetch(webRequest)
    )
    return writeWebResponseToAdonisResponse(webResponse, ctx.response)
  }
}
```

- [ ] **Step 2: Write tests for the dispatch middleware**

Create `tests/middleware/dispatch.spec.ts`:

```ts
import { test } from '@japa/runner'
import { setupApp } from '../helpers.js'
import XrpcDispatchMiddleware from '../../src/middleware/dispatch.js'
import { XrpcServer } from '../../src/xrpc_server.js'

test.group('XrpcDispatchMiddleware', (group) => {
  group.each.setup(() => setupApp())

  test('passes through non-/xrpc/* requests untouched', async ({ assert, app }) => {
    const middleware = new XrpcDispatchMiddleware()
    let nextCalled = false
    const ctx = {
      request: { url: () => '/some/other/path' },
      response: {},
      containerResolver: app.container.createResolver(),
    } as any

    await middleware.handle(ctx, async () => {
      nextCalled = true
    })

    assert.isTrue(nextCalled, 'next() should have been called for non-xrpc paths')
  })

  test('throws RuntimeException if no XrpcServer is bound on /xrpc/* paths', async ({
    assert,
    app,
  }) => {
    const middleware = new XrpcDispatchMiddleware()
    const ctx = {
      request: { url: () => '/xrpc/com.example.ping' },
      response: {},
      containerResolver: app.container.createResolver(),
    } as any

    await assert.rejects(
      async () => middleware.handle(ctx, async () => {}),
      /XrpcServer.+not bound|cannot resolve/i
    )
  })
})
```

The end-to-end "real request → middleware → atcute → handler → response" flow is covered by Task 8's functional test.

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm quick:test --files tests/middleware/dispatch.spec.ts`
Expected: PASS — 2 tests.

- [ ] **Step 4: Commit**

```bash
git add src/middleware/dispatch.ts tests/middleware/dispatch.spec.ts
git commit -m "feat(xrpc): add XrpcDispatchMiddleware (HTTP path intercept + atcute handoff)"
```

---

## Task 7b: Minimal provider (`providers/provider.ts`)

**Files:**

- Create: `providers/provider.ts` — minimal lifecycle wiring for the dispatch layer
- Create: `tests/provider.spec.ts` — unit tests for the provider's boot/ready effects

**Why a provider in Plan 03**: the original plan deferred the provider to Plan 04, with Tasks 8/10 hand-rolling the XrpcServer wiring in `setupApp`'s `beforeReady`. That works mechanically but produces awkward tests and a latent timing bug (the `nodeServer` doesn't exist until `app.start(cb)` fires, AFTER `beforeReady`). The idiomatic AdonisJS test shape — what `adonisjs-respond-with` and the framework's own packages use — is to load the provider via `rcFileContents.providers` and let the provider's `boot()` / `ready()` hooks do the wiring at the right lifecycle phase. This task ships the minimum provider Plan 03 needs to make that pattern work; Plan 04 layers `XrpcService` (errorHandler / subscriptionErrorHandler facades), the `HttpContext.xrpc` Macroable getter, and atcute's `handleException` / `handleSubscriptionException` wiring on top.

What this minimal provider does:

- **`register()`**: bind the `XrpcRouter` as a container singleton. Runs before any provider's `boot()`, so the binding is available to other providers and to `boot()` itself.
- **`boot()`**: resolve the `XrpcRouter` singleton eagerly (so the getter body can return synchronously) and install a `router.xrpc` getter on `Router.prototype` via `Object.defineProperty`. The main `Router` class in `@adonisjs/http-server@8.x` does NOT extend `Macroable` (only the sub-classes — `Route`, `RouteGroup`, `BriskRoute`, `RouteResource`, `RouteMatchers` — do), so `Router.macro(...)` / `Router.getter(...)` aren't available. Mutating `Router.prototype` directly via `Object.defineProperty` is the same primitive `Macroable.getter` wraps internally (cf. `@poppinss/macroable/build/index.js` line 92). Uses `configurable: true` so tests can re-run `boot()` across multiple `setupApp()` calls without `TypeError: Cannot redefine property`.
- **`ready()`** (web environment only): commit the `XrpcRouter`, construct the atcute `XRPCRouter` + `XrpcSerializer` + executor + `XrpcServer`, container-bind `XrpcServer`, then `await xrpcServer.start()`. Provider `ready()` fires INSIDE `app.start(cb)` after `setNodeServer(...)` — so `XrpcServer.start()` sees the live `nodeServer` and `#installWebSocketHandler` runs naturally.

**Middleware mounting is NOT the provider's job** — that's a consumer choice in `start/kernel.ts` (production) and a `setupApp`-fixture concern (tests):

- Production: consumers add `server.use([() => import('@thisismissem/adonisjs-atproto-xrpc/middleware')])` to `start/kernel.ts`'s server-level middleware array. The configure command (Plan 01) prints instructions / patches the kernel for this; the consumer holds the trigger.
- Tests: `tests/helpers.ts`'s `setupApp` mounts the middleware in its `app.start(cb)` block (before `setNodeServer`, so the middleware chain is set up before requests fire). This is a setupApp change paired with Task 7b — the test fixture takes responsibility for what the consumer's kernel does in production.

Auto-mounting from the provider would be magical / hard to opt out of and would diverge from how every other AdonisJS middleware package works. Don't add it.

What Plan 04 will add (out of scope here):

- `XrpcService` facade (the `errorHandler(factory)` / `subscriptionErrorHandler(factory)` registration API)
- Container binding for `XrpcService` + `HttpContext.xrpc` Macroable getter
- Atcute's `XRPCRouter` construction widens to pass `handleException` + `handleSubscriptionException` hooks that delegate to the registered error handlers
- Provider `shutdown()` for graceful WS server teardown

**Steps:**

**Test discipline note**: TDD's RED step is skipped for this task — the failure mode of "module doesn't exist" is trivially predictable and catches nothing. Implementation first, then write tests, then verify pass. Same applies anywhere else the failing-test step would just be observing `Cannot find module …` — don't burn cycles on busy work.

- [ ] **Step 1: Implement `providers/provider.ts`**

```ts
import { Router } from '@adonisjs/core/http'
import { XRPCRouter } from '@atcute/xrpc-server'
import { createNodeWebSocket } from '@atcute/xrpc-server-node'
import type { ApplicationService } from '@adonisjs/core/types'
import type { ContainerProviderContract } from '@adonisjs/application/types'

import { XrpcRouter } from '../src/router.js'
import { XrpcServer, createXrpcExecutor } from '../src/xrpc_server.js'
import { XrpcSerializer } from '../src/serializer.js'

// The `Router.xrpc` type augmentation lives in `src/types.ts` (Plan 01
// Task 6 Step 4) so it's visible everywhere the package's types are
// loaded, without forcing each `router.xrpc` consumer to side-effect-
// import this provider for typecheck. The runtime install happens
// inline in boot() below.

/**
 * Minimal XRPC provider — Plan 03 scope.
 *
 * register(): binds the XrpcRouter as a container singleton. Runs before
 * any other provider's boot(), so the binding is available by the time
 * boot() resolves it.
 *
 * boot(): resolves the XrpcRouter singleton eagerly and installs a
 * `router.xrpc` getter on `Router.prototype` via `Object.defineProperty`.
 * (The main `Router` class isn't `Macroable` in `@adonisjs/http-server@8.x`
 * — only the route sub-classes are — so `Router.macro(...)` /
 * `Router.getter(...)` aren't available; the prototype-property primitive
 * is what `Macroable.getter` wraps internally anyway.) Middleware
 * mounting is the consumer's responsibility (start/kernel.ts) or
 * setupApp's (tests) — not the provider's.
 *
 * start() (all environments): commits the XrpcRouter so further
 * `router.xrpc.*()` registrations throw. Not gated on env because Plan 06's
 * `list:xrpc:routes` ace command (and any other future console-env
 * tooling) needs to read the committed registry too. The provider
 * lifecycle puts `start()` after all preloads have loaded, which is the
 * moment after consumer routes have been registered and before the app
 * starts serving.
 *
 * ready() (web only): constructs the atcute XRPCRouter + executor +
 * XrpcServer, container-binds, then calls `XrpcServer.start()` to install
 * routes onto atcute and wire the WS upgrade handler. Plan 04 expands
 * this with `XrpcService` facade, error-reporter registration, and
 * atcute's handleException / handleSubscriptionException wiring.
 */
export default class XrpcProvider implements ContainerProviderContract {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton(XrpcRouter, () => new XrpcRouter(this.app))
    this.app.container.alias('xrpcRouter', XrpcRouter)
  }

  async boot() {
    // Resolve eagerly so the getter body can return synchronously —
    // `router.xrpc.procedure(...)` is called synchronously at consumer
    // route-definition time, so the getter can't hand back a Promise.
    // Router instances don't expose `app`/container themselves (their
    // `#app` field is private), so closure capture from boot() is the
    // only way to thread the resolved XrpcRouter into the getter body.
    const xrpcRouter = await this.app.container.make(XrpcRouter)

    // `configurable: true` so that re-running `boot()` across multiple
    // `setupApp()` calls in the test suite redefines the getter cleanly
    // rather than throwing `TypeError: Cannot redefine property`.
    Object.defineProperty(Router.prototype, 'xrpc', {
      get() { return xrpcRouter },
      configurable: true,
      enumerable: false,
    })
  }

  /**
   * `start()` runs between `boot()` and `ready()` in the AdonisJS provider
   * lifecycle — after all preloads have loaded (so consumer
   * `start/routes.ts` has had a chance to register XRPC routes) and before
   * the app is considered ready. This is the right semantic moment to
   * commit/seal the XrpcRouter: any further `router.xrpc.procedure(...)`
   * calls after commit() throw, which is what we want once the app is
   * about to serve traffic.
   *
   * Mirrors how `@adonisjs/http-server` commits its own router around the
   * same lifecycle phase.
   *
   * NOT gated on `environment === 'web'`. Ace commands (Plan 06's
   * `list:xrpc:routes`, etc.) run in the `console` env and need to read
   * the canonical committed registry. Preloads run in all environments by
   * default, so the XrpcRouter is fully populated by the time start()
   * fires regardless of env. Only `ready()` (which constructs the
   * dispatch server + WS handler) is web-only — those things have no use
   * in console/test envs.
   */
  async start() {
    const xrpcRouter = await this.app.container.make('xrpcRouter')
    xrpcRouter.commit()
  }

  async ready() {
    if (this.app.getEnvironment() !== 'web') return

    // By this point provider `start()` has already committed the XrpcRouter
    // — the executor sees the final operations map. We pass the live Map
    // reference (the executor reads from it at dispatch time); commit just
    // sealed further registration.
    const xrpcRouter = await this.app.container.make('xrpcRouter')
    const ws = createNodeWebSocket()
    const atcuteRouter = new XRPCRouter({ websocket: ws.adapter })
    const executor = createXrpcExecutor({
      operations: xrpcRouter.operations,
      serializer: new XrpcSerializer(),
    })
    const xrpcServer = new XrpcServer({
      app: this.app,
      router: atcuteRouter,
      ws,
      executor,
    })
    this.app.container.bindValue(XrpcServer, xrpcServer)

    await xrpcServer.start()
  }
}
```

Notes for the implementation:

- The `router.xrpc` getter is installed via `Object.defineProperty(Router.prototype, 'xrpc', { get() { return xrpcRouter }, configurable: true, enumerable: false })` inline in `boot()`. The main `Router` class isn't `Macroable`, so the prototype-property primitive replaces `Router.getter(...)`. `configurable: true` is required for re-runnable tests.
- `this.app.container.singleton(XrpcRouter, ...)` ensures we always have one XrpcRouter per app; the prototype getter is a thin accessor that returns the eagerly-resolved singleton from a closure-captured variable. The closure captures `xrpcRouter` only, not the provider instance — V8's static analysis correctly identifies that the getter body's free variables don't include `this`.
- Test setups that share an `app` across tests get a fresh container per setup (via `setupApp`'s `IgnitorFactory`), so no cross-test bleed of the singleton.
- The dispatch middleware is **not** mounted here — see the Task 7b intro for why and where it goes instead (consumer's `start/kernel.ts` in production; `setupApp`'s `app.start(cb)` block in tests).

- [ ] **Step 2: Write tests**

Create `tests/provider.spec.ts`:

```ts
import { test } from '@japa/runner'
import { setupApp } from './helpers.js'
import { XrpcServer } from '../src/xrpc_server.js'
import { XrpcRouter } from '../src/router.js'

test.group('XrpcProvider', () => {
  test('boot() installs the `router.xrpc` getter', async ({ assert }) => {
    const { app } = await setupApp({
      rcFileContents: {
        providers: [() => import('../providers/provider.js')],
      },
    })
    const router = await app.container.make('router')
    assert.instanceOf(router.xrpc, XrpcRouter)
  })

  test('start() commits the XrpcRouter; ready() constructs XrpcServer and calls its start()', async ({
    assert,
  }) => {
    const { app } = await setupApp({
      rcFileContents: {
        providers: [() => import('../providers/provider.js')],
      },
      beforeReady: async (app) => {
        // Register a route so commit() (in provider.start(), which fires
        // between preloads and ready()) seals a non-empty registry.
        const router = await app.container.make('router')
        router.xrpc.procedure(
          { id: 'com.example.ping', type: 'xrpc_procedure', defs: { main: {} } } as any,
          () => ({ pong: true })
        )
      },
    })

    const router = await app.container.make('router')
    assert.isTrue(
      router.xrpc.committed,
      'XrpcRouter should be committed by provider.start() (which runs before ready)'
    )

    const xrpcServer = await app.container.make(XrpcServer)
    assert.instanceOf(xrpcServer, XrpcServer)
  })

  test('start() commits in all environments; ready() skips XrpcServer wiring in non-web envs', async ({
    assert,
  }) => {
    // NOTE: this test needs `setupApp` to honor an `environment` option that
    // gets passed through to `TestUtilsFactory` (which forwards to
    // `ignitor.createApp(environment)`). The pre-existing `setupApp` signature
    // only forwards `{ rcFileContents, config }` to `IgnitorFactory.merge`.
    // Extend the fixture's signature here as part of this step (same shape
    // as Plan 01 Task 8 Step 2's `nodeEnvironment` extension note — these
    // are two distinct fixture knobs and both should land).
    const { app } = await setupApp({
      environment: 'console',
      rcFileContents: {
        providers: [() => import('../providers/provider.js')],
      },
      beforeReady: async (app) => {
        // Register a route so the XrpcRouter has something to commit. The
        // commit happens in provider.start() — which runs in console env
        // too, so ace commands (Plan 06's list:xrpc:routes) see a sealed
        // registry. Only XrpcServer construction is web-gated.
        const router = await app.container.make('router')
        router.xrpc.procedure(
          { id: 'com.example.ping', type: 'xrpc_procedure', defs: { main: {} } } as any,
          () => ({ pong: true })
        )
      },
    })

    const router = await app.container.make('router')
    assert.isTrue(
      router.xrpc.committed,
      'start() should have committed the XrpcRouter regardless of env'
    )

    // ready() is web-only, so XrpcServer is not bound in console env. Use
    // `hasBinding` rather than `container.make(XrpcServer)` because the
    // latter would try to auto-construct via @adonisjs/fold and fail with
    // a confusing "cannot resolve" error that isn't the assertion we want.
    assert.isFalse(
      app.container.hasBinding(XrpcServer),
      'ready() should not have constructed/bound XrpcServer in console env'
    )
  })
})
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm quick:test --files tests/provider.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 4: Wire dispatch middleware into `setupApp`'s `app.start(cb)` block**

In `tests/helpers.ts`, locate the existing `app.start(...)` callback in `setupApp` — it currently resolves `'server'`, boots it, creates the non-listening Node `http.Server`, and calls `setNodeServer(...)`. Add **one new line** registering the dispatch middleware, placed **before** `await adonisServer.boot()` so the chain has the middleware in it before boot walks the routes registry. Don't replace surrounding lines wholesale; the variable names in the existing fixture may differ from the snippet below.

The relevant region after the edit should look approximately like:

```ts
await testUtils.app.start(async () => {
  const adonisServer = await testUtils.app.container.make('server')
  // ADDED in Plan 03 Task 7b: register dispatch middleware — same shape
  // consumers add to start/kernel.ts in production.
  adonisServer.use([() => import('../src/middleware/dispatch.js')])
  await adonisServer.boot()
  const nodeServer = createServer(adonisServer.handle.bind(adonisServer))
  adonisServer.setNodeServer(nodeServer)
})
```

Only the `adonisServer.use([...])` line is genuinely new — match the existing variable name (`testUtils.app` vs. `testUtilsFactory.app` vs. whatever `096e257` uses) and the existing ordering of `boot()` / `createServer` / `setNodeServer`.

Why setupApp and not the provider: production consumers control middleware mounting via their `start/kernel.ts` — every other AdonisJS middleware package follows this pattern, and auto-mounting from the provider would be magical / hard to opt out of. setupApp does the kernel's job for the test fixture so individual tests don't have to repeat it.

- [ ] **Step 5: Leave the provider import in `tests/helpers.ts` commented**

The default `rcFileContents.providers` in setupApp already includes a commented-out reference to the provider. Leave it commented — tests that want the provider opt-in via the `parameters` argument (Tasks 8 and 10 demonstrate this). Default `setupApp()` keeps the previous semantics (no provider loaded) so configure / unit-test specs aren't affected.

- [ ] **Step 6: Commit**

```bash
git add providers/provider.ts tests/provider.spec.ts tests/helpers.ts
git commit -m "feat(xrpc): add minimal provider (router.xrpc + XrpcServer ready hook) and wire dispatch middleware in test setupApp"
```

---

## Task 8: Functional test — HTTP procedure + query end-to-end

**Files:**

- Create: `tests/dispatch.spec.ts`

Real Adonis pipeline, real atcute dispatch. Bootstraps an app via `setupApp({ rcFileContents: { providers: [...] } })` so Task 7b's minimal provider does the wiring (constructs the atcute `XRPCRouter` + `XrpcServer`, container-binds, commits the `XrpcRouter`, calls `start()`). Tests register XRPC routes in `beforeReady` via the provider-installed `router.xrpc` getter; setupApp's `app.start(cb)` block (extended in Task 7b Step 4) mounts the dispatch middleware in `server.use([...])`; and requests fire through `light-my-request`'s `inject(server.handle.bind(server))` — no port binding needed (same pattern Emelia uses in `fedimod/fires`'s `tests/plugins/request_tests.ts`). The HTTP path goes through the full Adonis pipeline; only the network socket is synthetic.

**Test-layering rationale**: this is the test that exercises the **real `fromHttpContext`** path end-to-end. The dispatch middleware receives the live Adonis `HttpContext` as a parameter and calls `requestContextStore.run(fromHttpContext(ctx), () => xrpcRouter.fetch(...))`; the registered atcute closure then reads from `requestContextStore.getStore()` and threads it into the executor. The Task 3 unit tests exercise the executor with a factory-built `RequestContext` (via `fromHttpContext(new HttpContextFactory().create())`); this test exercises the same materialization helper against a real `HttpContext` produced by the Adonis pipeline.

**Why the test body calls `server.boot()`**: in the test body, `const server = await app.container.make('server')` resolves Adonis's HTTP `Server` (from `@adonisjs/http-server`) — distinct from the `XrpcServer` constructed in `beforeReady`. `server.boot()` is what actually invokes the router-stuff: it walks the routes registry and mounts the middleware chain, including our dispatch middleware. Without it, `inject(server.handle.bind(server))` would hit a handler that hasn't run its boot phase and would 404 or worse. `boot()` is idempotent — safe to call defensively even if `setupApp`'s lifecycle already ran some of it. (Adonis testUtils' `HttpServerUtils.start()` does this same `boot()` step then proceeds to bind a real port; we stop at `boot()` and inject directly.)

**Steps:**

- [ ] **Step 1: Write the test**

Create `tests/dispatch.spec.ts`:

```ts
import { test } from '@japa/runner'
import inject from 'light-my-request'

import { setupApp } from './helpers.js'
import { XrpcRouter } from '../src/router.js'

const PING = {
  id: 'com.example.ping',
  type: 'xrpc_procedure',
  defs: {
    main: {
      type: 'procedure',
      input: { encoding: 'application/json', schema: { type: 'object' } },
      output: { encoding: 'application/json', schema: { type: 'object' } },
    },
  },
} as const

const ECHO_QUERY = {
  id: 'com.example.echo',
  type: 'xrpc_query',
  defs: {
    main: {
      type: 'query',
      parameters: { type: 'params', properties: { msg: { type: 'string' } } },
      output: { encoding: 'application/json', schema: { type: 'object' } },
    },
  },
} as const

test.group('dispatch — HTTP procedure + query end-to-end', (group) => {
  group.each.setup(async () => {
    const ctx = await setupApp({
      rcFileContents: {
        providers: [() => import('../providers/provider.js')],
      },
      beforeReady: async (app) => {
        // Register XRPC routes via the provider-installed router.xrpc getter.
        // The provider's ready() (which fires after this) commits the
        // XrpcRouter and starts the XrpcServer.
        const router = await app.container.make('router')
        router.xrpc.procedure(PING as any, () => ({ pong: true }))
        router.xrpc.query(ECHO_QUERY as any, (ctx) => ({ echoed: ctx.params.msg }))

        // Register a non-XRPC Adonis route so the fall-through test below
        // can prove the dispatch middleware called next() rather than just
        // observing a default 404 (which Adonis would return regardless).
        router.get('/healthz', () => ({ status: 'ok' })).as('healthz')
        router.commit()
      },
    })
    return ctx
  })

  test('POST /xrpc/com.example.ping returns the handler result as JSON', async ({
    assert,
    app,
  }) => {
    const server = await app.container.make('server')
    await server.boot()
    const response = await inject(server.handle.bind(server))
      .post('/xrpc/com.example.ping')
      .headers({ 'content-type': 'application/json' })
      .payload(JSON.stringify({}))
    assert.equal(response.statusCode, 200)
    assert.deepEqual(JSON.parse(response.payload), { pong: true })
  })

  test('GET /xrpc/com.example.echo?msg=hello returns the typed query response', async ({
    assert,
    app,
  }) => {
    const server = await app.container.make('server')
    await server.boot()
    const response = await inject(server.handle.bind(server)).get(
      '/xrpc/com.example.echo?msg=hello'
    )
    assert.equal(response.statusCode, 200)
    assert.deepEqual(JSON.parse(response.payload), { echoed: 'hello' })
  })

  test('non-/xrpc/* paths fall through the dispatch middleware to an Adonis route', async ({
    assert,
    app,
  }) => {
    // `/healthz` is registered as a plain Adonis route in beforeReady above.
    // If the dispatch middleware short-circuited every request (instead of
    // calling next() for non-/xrpc/* paths), this route would be unreachable
    // and the test would 404. A 200 + the expected body is positive evidence
    // that next() was called and the request continued down the middleware
    // chain to the Adonis router.
    const server = await app.container.make('server')
    await server.boot()
    const response = await inject(server.handle.bind(server)).get('/healthz')
    assert.equal(response.statusCode, 200)
    assert.deepEqual(JSON.parse(response.payload), { status: 'ok' })
  })
})
```

`light-my-request` injects directly into the Adonis HTTP server's request handler — no port binding, no real socket, but the full Adonis middleware pipeline (including our dispatch middleware) runs against the synthetic request. Pattern lifted from `fedimod/fires/components/fires-server/tests/plugins/request_tests.ts`. Task 10's WebSocket subscription test uses a sibling pattern (`injectXrpcSubscription` from Task 9, which fires a synthetic `'upgrade'` emit instead of a real WS connection) — also no port binding.

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm quick:test --files tests/dispatch.spec.ts`
Expected: PASS — 3 tests.

If atcute's `XRPCRouter` constructor signature differs from `new XRPCRouter({ websocket: ws.adapter })`, adjust per the actual signature surfaced by Step 0b. If the lexicon-shape validation rejects our minimal test lexicons (missing fields), pad them with the minimum atcute requires.

- [ ] **Step 3: Commit**

```bash
git add tests/dispatch.spec.ts
git commit -m "test(xrpc): end-to-end HTTP procedure + query dispatch against real Adonis server"
```

---

## Task 9a: Implement `src/event-stream/framing.ts` (public framing surface)

**Files:**

- Create: `src/event-stream/framing.ts` — `decodeFrame` / `encodeFrame` / `DecodedFrame` / `FrameHeader` / `ErrorFrameBody`
- Create: `tests/event-stream/framing.spec.ts` — round-trip + decode + encode + error-frame + invalid-header tests

This task ships before Task 9 because Task 9 (`injectXrpcSubscription`) imports `decodeFrame` from this module. The module is a public package surface (subpath `@thisismissem/adonisjs-atproto-xrpc/event-stream/framing`) — not test-only — because atcute provides the CBOR primitives (`@atcute/cbor`'s `encode` / `decode` / `decodeFirst`) but doesn't ship a high-level frame decoder for atproto's event-stream wire format. Consumer subscription clients and tests both need this.

**Why public, why now**: the labeler package (sibling repo) currently has a near-identical `src/framing.ts`; promoting this to a public surface of the XRPC package gives consumers a single canonical implementation and unblocks deleting the labeler's copy once it migrates to the XRPC subscription dispatch (planned post-Plan-03). The `DecodedFrame` discriminated-union shape (`{ type: 'message' } | { type: 'error' }`) is the consumer-facing API — typed narrowing on `frame.type` reads cleanly.

**Steps:**

- [ ] **Step 1: Implement `src/event-stream/framing.ts`**

```ts
import { decode, decodeFirst, encode } from '@atcute/cbor'

/**
 * Atproto event-stream frame header. Reference:
 * https://atproto.com/specs/event-stream
 *
 * - `op: 1` — message frame; `t` is the type discriminator (e.g. `'#commit'`,
 *   `'#labels'`), relative to the subscription's NSID.
 * - `op: -1` — error frame; body is `ErrorFrameBody`.
 */
export interface FrameHeader {
  op: 1 | -1
  t?: string
}

/**
 * Body shape for error frames (op = -1). `error` is the atproto error code
 * (e.g. `'FutureCursor'`); `message` is an optional human-readable detail.
 */
export interface ErrorFrameBody {
  error: string
  message?: string
}

/**
 * Discriminated-union result of decoding an atproto frame buffer. Consumers
 * `switch (frame.type)` to get TypeScript narrowing on the body shape:
 *
 * - `'message'` — `body` is the decoded message body (caller validates against
 *   the lexicon's message union); `discriminator` is the `#ref` from the
 *   header's `t` field, e.g. `'#commit'`.
 * - `'error'` — `error` and `message` are decoded from the error-frame body.
 */
export type DecodedFrame =
  | { type: 'message'; body: unknown; discriminator?: string }
  | { type: 'error'; error: string; message?: string }

/**
 * Decode an atproto event-stream frame: two CBOR objects (header + body)
 * concatenated in a single binary message. Returns a `DecodedFrame` narrowed
 * by `op` (1 = message, -1 = error).
 *
 * Throws on:
 * - Malformed CBOR (propagated from `@atcute/cbor`).
 * - Invalid header shape (op outside {1, -1}, or `t` non-string-or-undefined).
 *
 * Atcute provides the encoding/decoding building blocks but doesn't ship a
 * high-level frame decoder — this is the missing piece for consuming
 * subscriptions and writing tests against them.
 */
export function decodeFrame(buffer: Uint8Array): DecodedFrame {
  const [header, afterHeader] = decodeFirst(buffer)
  if (!isValidHeader(header)) {
    throw new Error('invalid frame header')
  }
  const body = decode(afterHeader)
  if (header.op === 1) {
    return { type: 'message', body, discriminator: header.t }
  }
  const errorBody = body as ErrorFrameBody
  return { type: 'error', error: errorBody.error, message: errorBody.message }
}

/**
 * Encode a `DecodedFrame` back to wire bytes. Symmetric with `decodeFrame` —
 * round-trips cleanly. Use from tests to construct synthetic frames against
 * stub WebSocket servers, or from consumer code that needs to inject pre-
 * decoded messages into a pipeline.
 *
 * The package's own subscription dispatch path does NOT use this — atcute's
 * `XRPCRouter` handles frame encoding internally for subscription handlers'
 * yielded values.
 */
export function encodeFrame(frame: DecodedFrame): Uint8Array {
  if (frame.type === 'message') {
    const header = encode(frame.discriminator ? { op: 1, t: frame.discriminator } : { op: 1 })
    const body = encode(frame.body)
    return concatBytes(header, body)
  }
  const header = encode({ op: -1 })
  const body = encode(
    frame.message ? { error: frame.error, message: frame.message } : { error: frame.error }
  )
  return concatBytes(header, body)
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function isValidHeader(value: unknown): value is FrameHeader {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return (obj.op === 1 || obj.op === -1) && (obj.t === undefined || typeof obj.t === 'string')
}
```

- [ ] **Step 2: Write tests**

Create `tests/event-stream/framing.spec.ts`:

```ts
import { test } from '@japa/runner'
import { encode } from '@atcute/cbor'
import { decodeFrame, encodeFrame, type DecodedFrame } from '../../src/event-stream/framing.js'

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

test.group('decodeFrame', () => {
  test('decodes a message frame with discriminator', ({ assert }) => {
    const buffer = concatBytes(encode({ op: 1, t: '#tick' }), encode({ n: 7 }))
    const frame = decodeFrame(buffer)
    assert.equal(frame.type, 'message')
    if (frame.type !== 'message') return // type guard for the rest
    assert.equal(frame.discriminator, '#tick')
    assert.deepEqual(frame.body, { n: 7 })
  })

  test('decodes a message frame without discriminator', ({ assert }) => {
    const buffer = concatBytes(encode({ op: 1 }), encode({ value: 'plain' }))
    const frame = decodeFrame(buffer)
    assert.equal(frame.type, 'message')
    if (frame.type !== 'message') return
    assert.isUndefined(frame.discriminator)
    assert.deepEqual(frame.body, { value: 'plain' })
  })

  test('decodes an error frame with code + message', ({ assert }) => {
    const buffer = concatBytes(
      encode({ op: -1 }),
      encode({ error: 'FutureCursor', message: 'cursor is in the future' })
    )
    const frame = decodeFrame(buffer)
    assert.equal(frame.type, 'error')
    if (frame.type !== 'error') return
    assert.equal(frame.error, 'FutureCursor')
    assert.equal(frame.message, 'cursor is in the future')
  })

  test('decodes an error frame without message', ({ assert }) => {
    const buffer = concatBytes(encode({ op: -1 }), encode({ error: 'ConsumerTooSlow' }))
    const frame = decodeFrame(buffer)
    assert.equal(frame.type, 'error')
    if (frame.type !== 'error') return
    assert.equal(frame.error, 'ConsumerTooSlow')
    assert.isUndefined(frame.message)
  })

  test('throws on invalid header op', ({ assert }) => {
    const buffer = concatBytes(encode({ op: 99 }), encode({}))
    assert.throws(() => decodeFrame(buffer), /invalid frame header/)
  })

  test('throws on non-object header', ({ assert }) => {
    const buffer = concatBytes(encode('not-an-object'), encode({}))
    assert.throws(() => decodeFrame(buffer), /invalid frame header/)
  })
})

test.group('encodeFrame', () => {
  test('round-trips a message frame with discriminator', ({ assert }) => {
    const original: DecodedFrame = { type: 'message', discriminator: '#tick', body: { n: 42 } }
    const decoded = decodeFrame(encodeFrame(original))
    assert.deepEqual(decoded, original)
  })

  test('round-trips a message frame without discriminator', ({ assert }) => {
    const original: DecodedFrame = { type: 'message', body: { plain: true } }
    const decoded = decodeFrame(encodeFrame(original))
    assert.equal(decoded.type, 'message')
    if (decoded.type !== 'message') return
    assert.isUndefined(decoded.discriminator)
    assert.deepEqual(decoded.body, { plain: true })
  })

  test('round-trips an error frame', ({ assert }) => {
    const original: DecodedFrame = { type: 'error', error: 'FutureCursor', message: 'too far' }
    const decoded = decodeFrame(encodeFrame(original))
    assert.deepEqual(decoded, original)
  })
})
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm quick:test --files tests/event-stream/framing.spec.ts`
Expected: PASS — 9 tests (6 decode + 3 encode/round-trip).

- [ ] **Step 4: Commit**

```bash
git add src/event-stream/ tests/event-stream/
git commit -m "feat(xrpc): add public event-stream framing module (decodeFrame + encodeFrame + DecodedFrame union)"
```

---

## Task 9: Implement `src/test_utils.ts` (injectXrpcSubscription)

**Files:**

- Create: `src/test_utils.ts` — public test surface: `injectXrpcSubscription`
- Create: `tests/test_utils.spec.ts` — unit tests for `injectXrpcSubscription`

This task ships the public test affordance consumers (and Task 10 below) use to drive XRPC subscriptions without binding a real port. The generic synthetic-upgrade plumbing lives in [`light-my-websocket`](https://npmjs.com/package/light-my-websocket) (Emelia's published extraction of the `fastify-websocket` `injectWS` pattern); the atproto frame decoding lives in Task 9a's `src/event-stream/framing.ts` (`decodeFrame` + typed `DecodedFrame` discriminated union). `injectXrpcSubscription` wraps `injectWS` with XRPC-specific concerns: URL construction from `lexicon.id`, frame decoding via the framing module, and an `AsyncIterable<DecodedFrame>` consumer interface.

**Steps:**

- [ ] **Step 1: Implement `src/test_utils.ts`**

```ts
import type { Server } from 'node:http'
import type WebSocket from 'ws'
import { injectWS } from 'light-my-websocket'

import type { XrpcSubscriptionLexicon } from './types.js'
import { decodeFrame, type DecodedFrame } from './event-stream/framing.js'

// Re-export `DecodedFrame` so consumers don't need a second import path
// for the type they'll be switching on inside `messages()` iteration.
export type { DecodedFrame }

export interface InjectXrpcSubscriptionOptions {
  /** URL search params (e.g. `cursor` for subscriptions that support resumption). */
  params?: Record<string, string | number | string[]>
  /** Additional request headers. */
  headers?: Record<string, string>
}

export interface InjectedXrpcSubscription {
  /**
   * Async iterable of decoded frames. Consumers typically iterate with
   * `for await ... break` until they've observed enough — subscriptions
   * don't have a natural end, so the test decides when. Each frame is a
   * `DecodedFrame` discriminated union (`{ type: 'message' } | { type: 'error' }`).
   *
   * **FOLLOW-UP (revisit during implementation)**: this signature is a
   * first-pass guess. Once the helper is built and the Task 10 functional
   * test exercises it end-to-end, evaluate whether the shape feels right
   * to use — concrete questions to answer:
   *   - Should the return type be `AsyncGenerator<DecodedFrame>` instead
   *     of `AsyncIterable<DecodedFrame>` (so consumers get `.return()` /
   *     `.throw()` typed)?
   *   - Should it be a method returning a fresh iterable each call, or a
   *     getter / property holding a single shared iterable? (Method
   *     returning fresh allows multiple concurrent iterators but might
   *     surprise consumers who expect "the messages stream").
   *   - How does `close()` interact with in-flight iteration — does it
   *     cause the iterator to cleanly `done: true`, or throw?
   *   - Does `injectXrpcSubscription` need any kind of "wait for first
   *     frame" affordance, or is `messages().next()` sufficient?
   * If the shape changes, propagate the rename / signature update through
   * Task 10's functional test and any consumer-facing docs. Not blocking
   * Plan 03 — just don't lock it in unconsciously.
   */
  messages(): AsyncIterable<DecodedFrame>
  /** Close the WebSocket from the client side. Resolves when fully closed. */
  close(code?: number, reason?: string): Promise<void>
  /** Underlying `ws.WebSocket` client — escape hatch for protocol-level assertions. */
  socket: WebSocket
}

/**
 * Test helper: open a synthetic WebSocket against `server` for an XRPC
 * subscription route. Constructs `/xrpc/<lexicon.id>?<params>`, runs the
 * synthetic-upgrade dance via `injectWS`, and returns an iterable of
 * decoded atproto frames (via `decodeFrame` from the public
 * `./event-stream/framing.js` surface).
 *
 * Use from `tests/` only. Requires a Node `http.Server` that has been
 * attached to the Adonis server via `setNodeServer(...)` so
 * `XrpcServer.#installWebSocketHandler` had a chance to wire its
 * upgrade listener. Plan 03 Task 10's `beforeReady` shows the setup.
 */
export async function injectXrpcSubscription<L extends XrpcSubscriptionLexicon>(
  server: Server,
  lexicon: L,
  options: InjectXrpcSubscriptionOptions = {}
): Promise<InjectedXrpcSubscription> {
  const url = new URL(`/xrpc/${lexicon.id}`, 'http://localhost')
  for (const [k, v] of Object.entries(options.params ?? {})) {
    if (Array.isArray(v)) {
      for (const item of v) url.searchParams.append(k, String(item))
    } else {
      url.searchParams.set(k, String(v))
    }
  }

  const ws = await injectWS(server, url.pathname + url.search, {
    headers: options.headers,
  })

  async function* messages(): AsyncIterable<DecodedFrame> {
    while (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      const data = await new Promise<Buffer | undefined>((resolve) => {
        const cleanup = () => {
          ws.off('message', onMessage)
          ws.off('close', onClose)
          ws.off('error', onError)
        }
        const onMessage = (chunk: Buffer) => {
          cleanup()
          resolve(chunk)
        }
        const onClose = () => {
          cleanup()
          resolve(undefined)
        }
        const onError = () => {
          cleanup()
          resolve(undefined)
        }
        ws.once('message', onMessage)
        ws.once('close', onClose)
        ws.once('error', onError)
      })
      if (!data) return
      yield decodeFrame(data)
    }
  }

  async function close(code?: number, reason?: string): Promise<void> {
    if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) return
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
    ws.close(code, reason)
    await closed
  }

  return { messages, close, socket: ws }
}
```

- [ ] **Step 2: Write tests for `injectXrpcSubscription`**

Create `tests/test_utils.spec.ts`:

```ts
import { test } from '@japa/runner'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { encode } from '@atcute/cbor'
import { injectXrpcSubscription } from '../src/test_utils.js'

const STREAM_LEX = {
  id: 'com.example.stream',
  type: 'xrpc_subscription',
  defs: {
    main: { type: 'subscription', message: { schema: { type: 'union', refs: ['#tick'] } } },
    tick: { type: 'object', properties: { n: { type: 'integer' } } },
  },
} as const

test.group('injectXrpcSubscription', () => {
  test('constructs /xrpc/<nsid>?<params> URL from the lexicon + options', async ({ assert }) => {
    let observedUrl = ''
    const wss = new WebSocketServer({ noServer: true })
    const server = createServer()
    server.on('upgrade', (req, socket, head) => {
      observedUrl = req.url || ''
      wss.handleUpgrade(req, socket, head, (ws) => ws.close())
    })

    const stream = await injectXrpcSubscription(server, STREAM_LEX as any, {
      params: { cursor: 42 },
    })
    await stream.close()

    assert.equal(observedUrl, '/xrpc/com.example.stream?cursor=42')
  })

  test('decodes atproto frames (header + body CBOR) and yields typed messages', async ({
    assert,
  }) => {
    const wss = new WebSocketServer({ noServer: true })
    const server = createServer()
    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const header = encode({ op: 1, t: '#tick' })
        ws.send(Buffer.concat([header, encode({ n: 7 })]))
        ws.send(Buffer.concat([header, encode({ n: 8 })]))
        ws.close()
      })
    })

    const stream = await injectXrpcSubscription(server, STREAM_LEX as any)
    const collected: any[] = []
    for await (const frame of stream.messages()) {
      collected.push(frame)
    }

    assert.lengthOf(collected, 2)
    // First message:
    assert.equal(collected[0].type, 'message')
    assert.equal(collected[0].discriminator, '#tick')
    assert.deepEqual(collected[0].body, { n: 7 })
    // Second message:
    assert.equal(collected[0].type, 'message')
    assert.equal(collected[0].discriminator, '#tick')
    assert.deepEqual(collected[0].body, { n: 8 })
  })
})
```

Note: the discriminated-union shape (`{ type: 'message', discriminator?: string, body: unknown } | { type: 'error', error: string, message?: string }`) comes from `src/event-stream/framing.ts` (Task 9a). Test_utils re-exports `DecodedFrame` for convenience.

- [ ] **Step 3: Run `test_utils` tests to verify they pass**

Run: `pnpm quick:test --files tests/test_utils.spec.ts`
Expected: PASS — 2 tests (URL construction + CBOR frame decoding). The synthetic-upgrade plumbing itself isn't tested here — that's `light-my-websocket`'s own test suite's job; we just exercise our XRPC-aware wrapper.

- [ ] **Step 4: Commit**

```bash
git add src/test_utils.ts tests/test_utils.spec.ts
git commit -m "feat(xrpc): add test_utils with injectXrpcSubscription (light-my-websocket-backed)"
```

---

## Task 10: Functional test — WebSocket subscription end-to-end

**Files:**

- Create: `tests/dispatch_subscription.spec.ts`

Same setup as Task 8 but exercises the subscription path: a synthetic WebSocket client (driven via `injectXrpcSubscription` from Task 9, which uses `light-my-websocket` under the hood — no port binding) connects to `/xrpc/com.example.stream`, the handler yields 3 frames, the client receives them, and the decoded discriminated-union values are asserted against expected messages.

Frame decoding goes through the public `decodeFrame` from `src/event-stream/framing.ts` (Task 9a) — the same surface consumers will use. The labeler package's own `src/framing.ts` is a near-identical precedent that will eventually be deleted in favor of importing from this package.

**Steps:**

- [ ] **Step 1: Write the test**

Create `tests/dispatch_subscription.spec.ts`:

```ts
import { test } from '@japa/runner'

import { setupApp } from './helpers.js'
import { XrpcRouter } from '../src/router.js'
import { injectXrpcSubscription } from '../src/test_utils.js'

const STREAM = {
  id: 'com.example.stream',
  type: 'xrpc_subscription',
  defs: {
    main: {
      type: 'subscription',
      message: { schema: { type: 'union', refs: ['#tick'] } },
    },
    tick: {
      type: 'object',
      properties: { n: { type: 'integer' } },
      required: ['n'],
    },
  },
} as const

test.group('dispatch — WebSocket subscription end-to-end', (group) => {
  group.each.setup(async () => {
    return setupApp({
      rcFileContents: {
        providers: [() => import('../providers/provider.js')],
      },
      beforeReady: async (app) => {
        // Register the subscription via the provider-installed router.xrpc.
        // The provider's ready() commits + starts the XrpcServer; setupApp's
        // app.start(cb) attaches the nodeServer beforehand, so
        // #installWebSocketHandler runs against a real Node http.Server.
        const router = await app.container.make('router')
        router.xrpc.subscription(STREAM as any, async function* () {
          for (let n = 1; n <= 3; n++) {
            yield { $type: 'com.example.stream#tick', n }
          }
        })
      },
    })
  })

  test('WebSocket client receives all 3 yielded ticks via injectXrpcSubscription', async ({
    assert,
    app,
  }) => {
    const adonisServer = await app.container.make('server')
    const nodeServer = adonisServer.getNodeServer()!

    const stream = await injectXrpcSubscription(nodeServer, STREAM as any)
    const received: number[] = []
    for await (const frame of stream.messages()) {
      // Discriminated union narrowing: `frame.type === 'message'` gives access
      // to `discriminator` + `body`; `'error'` would give `error` + `message`.
      if (
        frame.type === 'message' &&
        frame.discriminator === '#tick' &&
        (frame.body as any)?.n !== undefined
      ) {
        received.push((frame.body as any).n)
      }
      if (received.length === 3) break
    }
    await stream.close()

    assert.deepEqual(received, [1, 2, 3])
  })

  test('non-XRPC upgrade requests fall through to other listeners (Vite HMR coexistence)', async ({
    assert,
    app,
  }) => {
    // Register a sibling 'upgrade' listener that handles a non-XRPC path —
    // simulates Adonis's Vite integration installing its HMR upgrade handler
    // alongside ours. If the snip-and-wrap in #installWebSocketHandler ever
    // regresses (or if atcute starts adding multiple listeners), atcute would
    // 404 this upgrade and the sibling listener never sees it.
    const adonisServer = await app.container.make('server')
    const nodeServer = adonisServer.getNodeServer()!
    let sawSiblingUpgrade = false
    nodeServer.on('upgrade', (req, socket) => {
      if (req.url === '/_vite/hmr') {
        sawSiblingUpgrade = true
        socket.write('HTTP/1.1 200 OK\r\n\r\n')
        socket.destroy()
      }
    })

    // Fire a synthetic upgrade for a non-XRPC path using injectWS directly
    // (this test doesn't need the XRPC frame-decoding wrapper).
    const { injectWS } = await import('light-my-websocket')
    try {
      await injectWS(nodeServer, { path: '/_vite/hmr' })
    } catch {
      // We expect the sibling listener to write a non-101 response and
      // destroy the socket — injectWS rejects with "Unexpected server response".
      // That's fine; the assertion below is the actual proof of fall-through.
    }

    assert.isTrue(sawSiblingUpgrade, 'sibling /_vite/hmr listener should have seen the upgrade')
  })
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm quick:test --files tests/dispatch_subscription.spec.ts`
Expected: PASS — 2 tests (the 3-ticks subscription test + the Vite HMR fall-through test). Frame decoding goes through `decodeFrame` from `src/event-stream/framing.ts` (Task 9a), so any decode failures show up as `'invalid frame header'` throws from the framing module rather than ad-hoc test-helper errors.

- [ ] **Step 3: Commit**

```bash
git add tests/dispatch_subscription.spec.ts
git commit -m "test(xrpc): end-to-end WebSocket subscription dispatch with real WS client"
```

---

## Task 11: Public exports + tsdown.entry + middleware/test_utils/event-stream-framing subpaths

**Files:**

- Modify: `package.json` (extend `tsdown.entry` for the new files; add `./middleware` + `./test_utils` + `./event-stream/framing` subpath exports)
- Modify: `index.ts` (no changes — dispatch internals stay internal)

**Steps:**

- [ ] **Step 1: Add `./middleware`, `./test_utils`, and `./event-stream/framing` subpath exports**

In `package.json`, extend the `exports` block:

```json
"exports": {
  ".": "./build/index.js",
  "./provider": "./build/providers/provider.js",
  "./services/xrpc": "./build/services/xrpc.js",
  "./middleware": "./build/src/middleware/dispatch.js",
  "./test_utils": "./build/src/test_utils.js",
  "./event-stream/framing": "./build/src/event-stream/framing.js",
  "./types": "./build/src/types.js",
  "./factories/xrpc": "./build/factories/xrpc.js",
  "./errors": "./build/src/errors.js"
},
```

The middleware needs a subpath because consumers reference it as a lazy `() => import('@thisismissem/adonisjs-atproto-xrpc/middleware')` in their `start/kernel.ts` — the lazy-import shape is what Adonis's `server.use([...])` accepts. The test_utils subpath gates the test-only helpers behind an explicit import path so consumers' production bundles don't accidentally pull in `ws`/`light-my-websocket`'s test-side code paths. The `event-stream/framing` subpath exposes the public `decodeFrame`/`encodeFrame`/`DecodedFrame` surface — atcute doesn't ship a high-level frame decoder, so this is the canonical place for subscription consumers (including the labeler) to import from. The nested `event-stream/` prefix anticipates future modules in the same domain (cursor encoding, schema validation, error helpers) without polluting the top-level subpath namespace.

- [ ] **Step 2: Extend `tsdown.entry`**

In `package.json`, replace the `tsdown.entry` array with:

```json
"entry": [
  "./index.ts",
  "./configure.ts",
  "./providers/provider.ts",
  "./services/xrpc.ts",
  "./src/types.ts",
  "./src/router.ts",
  "./src/context.ts",
  "./src/errors.ts",
  "./src/serializer.ts",
  "./src/utils.ts",
  "./src/xrpc_server.ts",
  "./src/middleware/dispatch.ts",
  "./src/test_utils.ts",
  "./src/event-stream/framing.ts",
  "./factories/xrpc.ts"
],
```

- [ ] **Step 3: Run the full pipeline**

Run: `pnpm test`
Expected: PASS — lint, format check, typecheck, all tests.

- [ ] **Step 4: Verify the published type-shape**

Run: `pnpm build && pnpm types:check`
Expected: ESM-only and node16 profiles PASS. `./middleware` subpath should appear in `attw`'s report with both `import` and `types` resolutions valid.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "feat(xrpc): expose ./middleware, ./test_utils, ./event-stream/framing subpaths and wire tsdown entries for dispatch"
```

---

## Task 12: Changeset entry

**Files:**

- Create: `.changeset/<auto-generated>.md`

**Steps:**

- [ ] **Step 1: Generate the changeset**

Run: `pnpm changeset`

Walk the prompt:

- Selected package: `@thisismissem/adonisjs-atproto-xrpc`
- Bump type: **minor** (v0.x, new public surface — `./middleware`, `./test_utils`, and `./event-stream/framing` subpaths + new deps; XrpcServer / executor stay internal in this plan but the middleware is consumer-mounted in `kernel.ts`)
- Summary: `Ship the XRPC dispatch layer: XrpcServer wraps @atcute/xrpc-server's XRPCRouter + WebSocket adapter, the shared executor function handles every registered route (procedure, query, subscription) with closure-deduplication, and XrpcDispatchMiddleware intercepts /xrpc/* paths from start/kernel.ts. Also ships a public event-stream framing module (decodeFrame / encodeFrame / DecodedFrame discriminated union) filling a gap atcute leaves open. Provider lifecycle expansion (Plan 04) splices into the explicit error-reporting seam left in the executor.`

- [ ] **Step 2: Commit the changeset**

```bash
git add .changeset/
git commit -m "chore: changeset for dispatch layer"
```

---

## Self-review

Run through this checklist before handing off:

- [ ] **Spec coverage:** Each item below has a task above (or is explicitly out of scope per the "Out of scope" header section).
  - `XrpcServer` class with `start()` + `#installRoutes` + `#installWebSocketHandler` — Tasks 5, 6 ✓
  - `createXrpcExecutor` (HTTP path with handler resolution + serialization + error wrapping) — Task 3 ✓
  - `wrapSubscriptionIterator` (subscription branch + XrpcError → XRPCSubscriptionError translation) — Task 4 ✓
  - `requestContextStore` ALS (typed `AsyncLocalStorage<RequestContext>`) + `fromHttpContext` helper — Task 2 ✓
  - Synthetic HttpContext construction at the 'upgrade' event — Task 6 ✓
  - Snip-and-wrap of atcute's upgrade listener (replaces the original "ours first, atcute's second" design — see Task 6 intro) — Task 6 ✓
  - `XrpcDispatchMiddleware` (HTTP path intercept + atcute handoff) — Task 7 ✓
  - Minimal `XrpcProvider` (router.xrpc getter + dispatch middleware mount + XrpcServer construction & start) — Task 7b ✓
  - Public framing surface (`decodeFrame` + `encodeFrame` + `DecodedFrame` discriminated union) at `./event-stream/framing` subpath — Task 9a ✓
  - `injectWS` + `injectXrpcSubscription` test helpers (`./test_utils` subpath, single-file at `src/test_utils.ts`) — Task 9 ✓
  - `./middleware`, `./test_utils`, and `./event-stream/framing` subpath exports — Task 11 ✓
  - Functional HTTP test (procedure + query) — Task 8 ✓
  - Functional WS test (subscription) — Task 10 ✓
  - `XrpcService` facade + error handler registration — out of scope, Plan 04 ✓
  - `HttpContext.xrpc` Macroable getter — out of scope, Plan 04 ✓

- [ ] **Type consistency:** `SharedXrpcExecutor` signature is `(atcuteCtx, requestCtx?: RequestContext) => Promise<Response> | AsyncIterable<unknown>` — return covers both `Promise<Response>` (HTTP path — the executor constructs a `Response` from `xrpcCtx.response.state` + the serialized body; atcute's router checks `output instanceof Response` and silently drops non-Response returns) and `AsyncIterable<unknown>` (subscription path — atcute iterates for frame encoding). `RouteInfo` from Plan 01 has no `auth` field (Plan 05 grafts it via declaration merging) — Plan 03's executor reads `RouteInfo` and is auth-agnostic. `XrpcContext` construction sources `requestId` / `request: HttpRequest` (Adonis) / `logger` / `containerResolver` from `requestCtx`, and `lexicon` / `input` / `params` / `signal` from `route` + `atcuteCtx` — with no `auth` field on the context. After `xrpcCtx` is constructed, every subsequent read in the executor (and in `wrapSubscriptionIterator`) sources from `xrpcCtx`, not `requestCtx`.

- [ ] **Forward-compat seams for Plan 04:** Two explicit seams are documented in the code with comment-anchors:
  - `ERROR-REPORTING SEAM (Plan 04)` in `createXrpcExecutor`'s catch block and in `wrapSubscriptionIterator`'s catch block.
  - Comment in `createXrpcExecutor`'s `deps` shape lists the future `xrpc: XrpcService` field explicitly so reviewers can see what's coming.

- [ ] **No placeholder text:** Grep for `TODO`, `FIXME`, `TBD` in the plan. The only intentionally-kept `TODO` is the upstream-PR note in Task 6 about adding a `urlPredicate` option to `@atcute/xrpc-server-node`'s `createNodeWebSocket` (would eliminate the snip-and-wrap dance); that's a deliberate follow-up marker, not unfinished plan content.

---

## Execution handoff

**Plan complete and saved to `docs/plans/2026-05-24-xrpc-plan-03-dispatch.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. The test_utils helper (Task 9) and the WebSocket subscription functional test (Task 10) are the highest-risk tasks (CBOR frame decoding, synthetic-upgrade plumbing) — consider checkpoint review before/after each.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Plans 04–07 still need to be drafted before any execution starts. Common pattern: draft all plans first, then execute. Plan 04 (provider integration) is the natural next plan — it consumes everything Plan 03 produces and wires it through the provider lifecycle.
