# XRPC Plan 04 — Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Model:** Claude Sonnet (current generation) — the design and audit work is settled in the spec and plans; execution is mechanical enough that Opus is overkill.

**Goal:** Expand Plan 03's minimal provider into the full `XrpcProvider` + `XrpcService` facade. After this plan, consumers register their `ExceptionHandler` subclass (from `app/exceptions/xrpc_handler.ts` — the stub published by Plan 01's configure command) via `xrpc.errorHandler(() => import('#exceptions/xrpc_handler'))` in `start/kernel.ts`, atcute's `XRPCRouter` is constructed with `handleException` / `handleSubscriptionException` hooks so atcute-internal errors (parse failures, route mismatches) flow through the same handler as handler-side errors, and the provider performs graceful WebSocket teardown on SIGTERM / dev-reload so subscription clients receive a clean 1001 (Going Away) frame instead of hanging until ping-timeout.

**Architecture:** `XrpcService` is the small consumer-facing facade — `@thisismissem/adonisjs-atproto-xrpc/services/xrpc` re-exports a singleton accessor in the shape of `@adonisjs/core/services/server`, so `import xrpc from '...'` works inside `start/kernel.ts`. Single registration slot: `xrpc.errorHandler(factory)` stores the lazy import; first error triggers resolution via `app.container.make(mod.default)` which constructs the consumer's subclass with the container's DI (the base class's `constructor(app: ApplicationService)` is auto-satisfied). The resolved instance is memoized.

The provider's `boot()` binds the `XrpcService` singleton alongside the existing `XrpcRouter` singleton. The provider's `ready()` widens Plan 03's atcute `XRPCRouter` construction to pass `handleException` + `handleSubscriptionException` (both delegate to the same `makeAtcuteHook(xrpc)` helper), and widens `createXrpcExecutor`'s `deps` to include `xrpc: XrpcService` — Plan 03's comment-anchored `// ERROR-REPORTING SEAM (Plan 04)` lines in the executor's procedure/query catch and `wrapSubscriptionIterator`'s catch become real calls: `await handler?.report(err, xrpcCtx)` (when `handler.shouldReport(err)` is truthy) followed by `throw await handler.handle(err, xrpcCtx)`. The returned `XrpcError` is what atcute wire-encodes — handler-side errors are sanitized by the consumer's `handle()` (default: env-aware via the `ExceptionHandler` base) before atcute sees them.

The provider's `shutdown()` hook delegates to a new `XrpcServer.shutdown(graceMs?)` that stops accepting new upgrades, sends 1001 to all connected clients, waits briefly, then `.terminate()`s survivors.

**Single-handler design** (collapsed from the spec's `errorHandler` + `subscriptionErrorHandler` split): the consumer's `ExceptionHandler` subclass handles BOTH procedure/query and subscription paths via a single `handle(error, ctx)` method. The `ctx.lexicon.type` discriminator (`'xrpc_procedure'` / `'xrpc_query'` / `'xrpc_subscription'`) inside the body lets consumers branch when needed; in practice most don't. This removes the fall-through machinery (`getRegisteredSubscriptionErrorHandler` resolving to `getRegisteredErrorHandler` when no subscription handler is set) entirely.

**Why no `HttpContext.xrpc` getter** (despite the spec sketching one in § _Container bindings — HttpContext.xrpc_): once Plan 03's dispatch middleware short-circuits the Adonis pipeline on `/xrpc/*` match AND the WS-subscription path stopped constructing a synthetic HttpContext (also a Plan 03 amendment), there's no Adonis-pipeline position where `ctx.xrpc` would resolve to anything but `undefined`. The original rationale (cross-cutting tagging from a shared `app/exceptions/handler.ts`) dissolves once you observe that the XRPC handler receives `xrpcCtx: XrpcContext` as its `ctx` argument directly — the consumer's `ExceptionHandler` subclass gets the XRPC context first-class without needing an HttpContext accessor. Code that wants the active XRPC context from non-XRPC code uses `XrpcContext.get()` (added in Plan 01 alongside `getOrFail()` — same shape as `HttpContext.get()` / `HttpContext.getOrFail()` on the Adonis side). Spec § _Container bindings — HttpContext.xrpc_ should be dropped on a future spec-amendment pass.

**Tech Stack:** TypeScript (ESM), Node ≥24, `@atcute/xrpc-server` (already added in Plan 03), `@atcute/xrpc-server-node` (already added), `@adonisjs/core` (peer; for `HttpContext.getter`, `ApplicationService`, the `services/app` pattern), `@japa/runner` + `@japa/assert` for tests. No new runtime dependencies — this plan composes existing pieces.

**Spec reference:** `docs/specs/2026-05-21-adonisjs-atproto-xrpc-design.md` §§ _XrpcService facade_, _Lifecycle phases_, _Error reporting (procedure/query and subscription)_, _Kernel registrations_. (Spec § _Container bindings — HttpContext.xrpc_ is intentionally NOT implemented — see "Why no HttpContext.xrpc getter" in the Architecture section above. The spec's two-handler split — `errorHandler` + `subscriptionErrorHandler` with fall-through — is also collapsed to a single `errorHandler`; see "Single-handler design" above.)

**Implementation scope:** The plan series (01–04) lands the XRPC package up to — but not including — auth. The design spec covers auth in full because the overall system had to be designed knowing where the seams sit and how `XrpcContext` would be shaped, but a plan-executing implementor doesn't need to think about auth at all: there are no auth-related comment-anchors, types, or "wire-here-later" placeholders left in this plan's code. When the auth work is eventually planned, it will lay its own seams against whatever the codebase looks like at that point (and per the spec will use `XrpcContext.macro('auth', ...)` to attach itself, so this plan's `XrpcContext` shape is auth-free without prejudice).

**Depends on:** Plan 03 (dispatch). Specifically — `XrpcServer`, `XrpcDispatchMiddleware`, `createXrpcExecutor` (with the `// ERROR-REPORTING SEAM (Plan 04)` comment-anchors in both the procedure/query catch block and the subscription wrapper's catch block), `wrapSubscriptionIterator`, the minimal `XrpcProvider` from Plan 03 Task 7b, and the public `./middleware` + `./test_utils` + `./event-stream/framing` subpaths. Plan 04 expands the provider; it does not replace it.

---

## Files

### Create

- `src/xrpc_service.ts` — `XrpcService` class (consumer-facing facade); single `errorHandler(factory)` slot; lazy resolution + memoization. (The `ExceptionHandler` base class itself ships in Plan 01 at `src/exception_handler.ts`.)
- `services/xrpc.ts` — six-line singleton accessor; the consumer's `start/kernel.ts` import target
- `tests/xrpc_service.spec.ts` — unit tests for `XrpcService` (factory storage, lazy resolution, memoization)
- `tests/provider_error_reporting.spec.ts` — functional tests: register an `ExceptionHandler` subclass, throw from procedure / subscription handlers / atcute-internal paths, assert `report()` fires + `handle()`'s returned `XrpcError` is what the client sees
- `tests/provider_shutdown.spec.ts` — functional test for `XrpcServer.shutdown()`: open a subscription, trigger shutdown, assert close frame received + handler generator exited + grace-window force-terminate path

### Modify

- `src/xrpc_server.ts` — widen `createXrpcExecutor`'s `deps` type to `{ operations, serializer, xrpc: XrpcService }`; replace the `// ERROR-REPORTING SEAM (Plan 04)` comments in both the procedure/query catch block and `wrapSubscriptionIterator`'s catch block with calls to the new `runConsumerHandler(xrpc, err, xrpcCtx)` helper (single source of truth for the `shouldReport → report → handle → REPORTED-stamp` sequence); add `XrpcServer.shutdown(graceMs?)` instance method; add `#shuttingDown` private field consulted by the upgrade wrapper installed in `#installWebSocketHandler`
- `providers/provider.ts` — expand Plan 03's minimal provider: bind `XrpcService` in `boot()` (alongside the existing `XrpcRouter` binding); widen `ready()` to construct atcute's `XRPCRouter` with `handleException` + `handleSubscriptionException` hooks and to pass `xrpc` into `createXrpcExecutor`'s deps; add `shutdown()` that delegates to `XrpcServer.shutdown()`
- `index.ts` — add public type export: `XrpcService` (`ExceptionHandler` class is already exported by Plan 01 Task 10)
- `package.json` — add the `./services/xrpc` subpath export entry; add the matching `tsdown.entry` entry; bump devDeps if a new test-helper dep is needed (none anticipated)
- `cspell.json` — add `gracefulShutdown` if cspell flags it (otherwise no change)

### Out of scope (later plans)

- **Ace commands** (`list:xrpc:routes`, `make:xrpc:controller`) → Plan 06.
- **`indexXrpc()` codegen hook** → Plan 07.

---

## Pre-flight checks

These verifications must pass before executing this plan. Don't run task subagents until each `[ ]` below is `[x]`.

- [ ] Plans 01, 02, 03 are committed to `main` and `pnpm test` passes on a clean checkout. The minimal provider from Plan 03 Task 7b is in place at `providers/provider.ts` with `boot()` + `start()` + `ready()` lifecycle wired.
- [ ] `cat providers/provider.ts` shows the Plan 03 minimal-provider shape: `register()` binds the `XrpcRouter` singleton, `boot()` installs the `router.xrpc` accessor on `Router.prototype`, `start()` commits the router, `ready()` (web-only) constructs the atcute `XRPCRouter` + executor + `XrpcServer`. (See Plan 03 § Task 7b for the install mechanism — `Router` isn't `Macroable`, so it's a direct `Object.defineProperty(Router.prototype, ...)`.)
- [ ] `grep -n 'ERROR-REPORTING SEAM (Plan 04)' src/xrpc_server.ts` returns three lines: one in `createXrpcExecutor`'s `deps` type comment, one in the procedure/query catch block, one in `wrapSubscriptionIterator`'s catch block. If any are missing, Plan 03 didn't land cleanly — back out and verify Plan 03 before continuing.
- [ ] **Verify atcute `XRPCRouterOptions` shape**: read `~/Development/git/github.com/mary-ext/atcute/packages/internal/xrpc-server/lib/router.ts` (on the `trunk` branch — see memory `atcute-repo-paths`) to confirm the `handleException` and `handleSubscriptionException` field names, signatures, and what atcute does by default when they're absent. The spec sketches them as wire-format encoding hooks — verify both: (a) their function signatures (specifically, what context object they receive), and (b) that throwing from inside one causes atcute to fall back to its default error encoding (vs. crashing the request). If the atcute API differs from the spec sketch, surface it as a finding before drafting Task 4's code — the rest of the plan keys off this shape.
- [ ] **Verify `ws.WebSocketServer.clients` iteration is safe under concurrent close**: read `~/Development/git/github.com/websockets/ws/lib/websocket-server.js` (if cloned; otherwise `pnpm info ws repository` and reach via raw GitHub) to confirm that iterating `wss.clients` while clients are closing is safe (the spec sketch in Task 5 assumes it is). If iteration must use `Array.from(wss.clients)` to snapshot, note that as a Task 5 adjustment.
- [ ] **Verify the `@adonisjs/core/services/server` singleton-accessor shape**: read `~/Development/git/github.com/adonisjs/core/services/server.ts` (on the `7.x` branch — see user CLAUDE.md AdonisJS section) to confirm the exact pattern (`import app from '@adonisjs/core/services/app'; let server; await app.booted(async () => { server = await app.container.make('server') }); export { server as default }`). Task 2's `services/xrpc.ts` must mirror this shape exactly — the export contract is what consumers depend on for `import xrpc from '...'` to give them an `XrpcService` instance synchronously after boot.
- [ ] **Verify Adonis provider `shutdown()` ordering vs `Application.terminate()`**: read `~/Development/git/github.com/adonisjs/core/src/application.ts` on the `7.x` branch to confirm that provider `shutdown()` hooks run BEFORE the Node HTTP server's `.close()` is called (this is what gives our 1001 close-frame loop time to reach clients before the underlying TCP socket dies). If the ordering is the other way around, Task 5's shutdown sequence needs adjustment — likely registering a process `SIGTERM` listener separately, which is uglier. Either way, document the ordering finding in Task 5's commit message.
- [ ] **Confirm Plan 01 amendment landed**: Plan 04's atcute `handleException` / `handleSubscriptionException` hooks (Task 4) and the executor catch blocks (Task 3) call `XrpcContext.get()` / `XrpcContext.getOrFail()`. Plan 01 currently defines `XrpcContext.getOrFail()`; the `get()` non-throwing variant was added as a Plan 01 amendment during Plan 04 drafting. Confirm `grep -n 'static get():' src/context.ts` returns a match before starting Task 4.

---

## Task 1: Implement `XrpcService` class

**Files:**

- Create: `src/xrpc_service.ts`
- Create: `tests/xrpc_service.spec.ts`

**Why this exists:** `XrpcService` is the small consumer-facing facade for XRPC-side exception handler registration. It's the bound-as-`'xrpc'` singleton that `services/xrpc.ts` resolves and that the provider's `ready()` passes into `createXrpcExecutor` so the executor's catch blocks can run errors through the consumer's `ExceptionHandler` subclass. Single registration slot: `errorHandler(factory)` holds a lazy import; first error triggers resolution via `app.container.make(mod.default)` (container DI satisfies the base class's `constructor(app)` automatically); the resolved instance is memoized for subsequent calls.

**Why not just hand the executor a resolved handler instance at boot time?** Because of the late-binding contract: `start/kernel.ts` runs AFTER the provider's `boot()` (kernel.ts is loaded as a preload), so the factory registration call (`xrpc.errorHandler(() => import('#exceptions/xrpc_handler'))`) happens after `XrpcService` exists but possibly before the first error fires. Storing the factory and resolving on first use is the same shape AdonisJS itself uses for `server.errorHandler(...)`.

**Why one registration slot (not two — see spec § _Kernel registrations_):** the spec's `errorHandler` + `subscriptionErrorHandler` split with fall-through assumed the handler class had no path-discrimination affordance, so the only way to do path-specific reporting was a separate class. With `ExceptionHandler`'s single `handle(error, ctx)` method, consumers branch on `ctx?.lexicon.type === 'xrpc_subscription'` inside the body — and most don't need to. The split was over-engineering for a use case that's better served by a switch in the handler body. Collapsing simplifies the API surface (no second registration to teach consumers about) and the internal resolution path (no fall-through logic, one memoization slot).

**Steps:**

**Test discipline note**: TDD's RED step is skipped — the failure modes for these steps would be "module not found" or "method not defined", both trivially predictable per the user's memory note. Implementation → tests → verify pass.

- [ ] **Step 1: Implement `src/xrpc_service.ts`**

````ts
import type { ApplicationService } from '@adonisjs/core/types'
import type { LazyImport } from '@poppinss/utils/types'

import type { ExceptionHandler } from './exception_handler.js'

/**
 * Module marker stamped on errors after the consumer's handler has run
 * once, so atcute's `handleException` / `handleSubscriptionException`
 * hooks can skip re-invoking it on the way out (handler-side errors
 * traverse the executor catch FIRST, then atcute's hook — the dedup
 * keeps reporting idempotent without trusting reporters to be so).
 *
 * The executor catch (Task 3) and the subscription wrapper catch stamp
 * this on the returned XrpcError before re-throwing. Plan 04's atcute
 * hooks (Task 4) check for it and short-circuit.
 *
 * @internal
 */
export const REPORTED: unique symbol = Symbol('xrpc:reported')

/**
 * The bound-as-`'xrpc'` consumer-facing facade.
 *
 * `XrpcService` is the public XRPC API surface; `XrpcServer` (in
 * `src/xrpc_server.ts`) is the internal dispatch orchestrator and never
 * imported by consumers. Mirrors how Adonis splits `server` (consumer-facing
 * singleton at `@adonisjs/core/services/server`) from internal HTTP machinery.
 *
 * `errorHandler(factory)` is late-bound: `start/kernel.ts` runs after `boot()`
 * (kernel.ts is loaded as a preload), so this instance must exist before
 * the registration call. The factory is held until first resolution; the
 * resolved instance is memoized for subsequent calls. Same pattern as
 * `server.errorHandler(...)` in Adonis core.
 *
 * The factory must point at a module whose default export is a class
 * extending the `ExceptionHandler` base class shipped by this package
 * (`@thisismissem/adonisjs-atproto-xrpc#ExceptionHandler`). Plan 01's
 * configure command publishes the consumer's `app/exceptions/xrpc_handler.ts`
 * starter file with the right subclass shape.
 */
export class XrpcService {
  #app: ApplicationService
  #errorHandlerFactory?: LazyImport<{ default: new (...args: any[]) => ExceptionHandler }>
  #resolvedErrorHandler?: ExceptionHandler

  constructor(app: ApplicationService) {
    this.#app = app
  }

  /**
   * Register the consumer's `ExceptionHandler` subclass. Called from
   * `start/kernel.ts`:
   *
   * ```ts
   * import xrpc from '@thisismissem/adonisjs-atproto-xrpc/services/xrpc'
   * xrpc.errorHandler(() => import('#exceptions/xrpc_handler'))
   * ```
   *
   * The factory is invoked lazily on first error; the resolved instance is
   * memoized.
   */
  errorHandler(factory: LazyImport<{ default: new (...args: any[]) => ExceptionHandler }>): this {
    this.#errorHandlerFactory = factory
    return this
  }

  /**
   * Resolve and memoize the registered exception handler. Called by the
   * executor's catch blocks, by `wrapSubscriptionIterator`'s catch block,
   * and by Plan 04's atcute hooks (all via the `xrpc` dep). Returns null
   * if no factory was registered (tests, or consumers who haven't set up
   * `start/kernel.ts` registration yet) — callers tolerate null by
   * skipping the report/handle invocation.
   *
   * @internal
   */
  async getRegisteredErrorHandler(): Promise<ExceptionHandler | null> {
    if (this.#resolvedErrorHandler) return this.#resolvedErrorHandler
    if (!this.#errorHandlerFactory) return null
    const mod = await this.#errorHandlerFactory()
    this.#resolvedErrorHandler = await this.#app.container.make(mod.default)
    return this.#resolvedErrorHandler
  }
}
````

Implementation notes:

- `app.container.make(mod.default)` rather than `new mod.default(app)` because the container handles DI: it sees the constructor signature `constructor(app: ApplicationService)` on the `ExceptionHandler` base class and supplies the app instance automatically. Same path Adonis's own server.errorHandler resolution uses.
- The `LazyImport<{ default: new (...args: any[]) => ExceptionHandler }>` type intentionally mirrors `@poppinss/utils`'s `LazyImport` shape. `LazyImport` is type-only.
- The `REPORTED` symbol export lives on this module (not on the provider) because it's a service-level concern: the executor (`src/xrpc_server.ts`) and atcute hooks (`providers/provider.ts`) both import it from here. Centralizing the marker on `XrpcService`'s module keeps the dedup contract obvious.

- [ ] **Step 2: Write tests** for `XrpcService`'s factory storage, lazy resolution, and memoization behavior.

Create `tests/xrpc_service.spec.ts`:

```ts
import { test } from '@japa/runner'
import { setupApp } from './helpers.js'
import { XrpcService } from '../src/xrpc_service.js'
import { ExceptionHandler } from '../src/exception_handler.js'

test.group('XrpcService', () => {
  test('errorHandler(factory) is called lazily on first getRegisteredErrorHandler()', async ({
    assert,
  }) => {
    const { app } = await setupApp({})
    const service = new XrpcService(app)

    let factoryCalls = 0
    class TestHandler extends ExceptionHandler {}

    service.errorHandler(async () => {
      factoryCalls++
      return { default: TestHandler }
    })

    assert.equal(factoryCalls, 0, 'factory not invoked until first resolution')

    const handler = await service.getRegisteredErrorHandler()
    assert.equal(factoryCalls, 1)
    assert.instanceOf(handler, TestHandler)

    const handler2 = await service.getRegisteredErrorHandler()
    assert.equal(factoryCalls, 1, 'factory not re-invoked — resolved handler is memoized')
    assert.strictEqual(handler, handler2)
  })

  test('getRegisteredErrorHandler() returns null when no factory registered', async ({
    assert,
  }) => {
    const { app } = await setupApp({})
    const service = new XrpcService(app)
    assert.isNull(await service.getRegisteredErrorHandler())
  })

  test('container.make-resolved handler has app injected (inherits ExceptionHandler defaults)', async ({
    assert,
  }) => {
    const { app } = await setupApp({})
    const service = new XrpcService(app)
    class TestHandler extends ExceptionHandler {}
    service.errorHandler(async () => ({ default: TestHandler }))

    const handler = await service.getRegisteredErrorHandler()
    // The base class's `handle` reads `this.app.inProduction` — verify the
    // container successfully injected `app` by exercising the default.
    assert.isFunction(handler!.handle)
    assert.isFunction(handler!.report)
    assert.isFunction(handler!.shouldReport)
  })
})
```

- [ ] **Step 3: Run tests to verify pass**

Run: `pnpm quick:test --files tests/xrpc_service.spec.ts`

Expected: all 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/xrpc_service.ts tests/xrpc_service.spec.ts
git commit -m "feat: add XrpcService facade for exception handler registration"
```

---

## Task 2: Implement `services/xrpc.ts` singleton accessor

**Files:**

- Create: `services/xrpc.ts`

**Why this exists:** Consumers don't reach into `app.container.make('xrpc')` from `start/kernel.ts` — that's not the Adonis idiom. The idiom is `import server from '@adonisjs/core/services/server'`, and we mirror it: `import xrpc from '@thisismissem/adonisjs-atproto-xrpc/services/xrpc'` should give back an `XrpcService` instance synchronously after the app has booted. The six-line file does that.

The file pattern is taken verbatim from `@adonisjs/core/services/server.ts` — module-level `let xrpc`, an `app.booted(async () => ...)` hook that resolves the singleton, and a `default` export. The top-level `await` works because the file is ESM and Node ≥24 supports top-level await in module evaluation. Consumers importing from this subpath see a resolved `XrpcService` because module resolution waits for the top-level promise.

**Steps:**

- [ ] **Step 1: Implement `services/xrpc.ts`**

````ts
import app from '@adonisjs/core/services/app'
import type { XrpcService } from '../src/xrpc_service.js'

let xrpc: XrpcService

/**
 * Returns a singleton `XrpcService` instance for the consumer to register
 * exception handlers against from `start/kernel.ts`:
 *
 * ```ts
 * import xrpc from '@thisismissem/adonisjs-atproto-xrpc/services/xrpc'
 * xrpc.errorHandler(() => import('#exceptions/handler'))
 * ```
 *
 * Mirrors `@adonisjs/core/services/server` in shape — the `app.booted(...)`
 * hook resolves the container binding registered by the provider's `boot()`.
 * Top-level await makes the default export a real `XrpcService` instance
 * once the importing module evaluates (Node ≥24, ESM).
 */
await app.booted(async () => {
  xrpc = await app.container.make('xrpc')
})

export { xrpc as default }
````

Implementation notes:

- The `let xrpc: XrpcService` declaration without initialization is the same shape `services/server.ts` uses — the variable is assigned inside the `booted()` callback. Consumers importing this module evaluate the top-level `await`, which means import resolution waits for `booted()` to fire. By the time a consumer's `start/kernel.ts` calls `xrpc.errorHandler(...)`, the value is bound.
- Don't `export default xrpc` in line with the `let` declaration — that captures the initial `undefined`. Use the `export { xrpc as default }` form after the `await`.
- TypeScript will complain that `xrpc` is "used before assigned" if you don't add a non-null assertion or change the declaration. The pattern Adonis uses is to declare with `!`: `let xrpc!: XrpcService`. Match that.

Adjusted version with the non-null assertion:

```ts
import app from '@adonisjs/core/services/app'
import type { XrpcService } from '../src/xrpc_service.js'

let xrpc!: XrpcService

await app.booted(async () => {
  xrpc = await app.container.make('xrpc')
})

export { xrpc as default }
```

- [ ] **Step 2: Verify the file typechecks**

Run: `pnpm typecheck`

Expected: PASS. No tests for this file — it's a six-line accessor whose behavior is exercised end-to-end by the functional tests in Task 6.

- [ ] **Step 3: Commit**

```bash
git add services/xrpc.ts
git commit -m "feat: add services/xrpc singleton accessor"
```

---

## Task 3: Widen `createXrpcExecutor` to run the ExceptionHandler

**Files:**

- Modify: `src/xrpc_server.ts` — widen `createXrpcExecutor`'s `deps` to include `xrpc: XrpcService`; replace `// ERROR-REPORTING SEAM (Plan 04)` comments in both the procedure/query catch block and `wrapSubscriptionIterator`'s catch block with real `handler.report(...)` + `throw await handler.handle(...)` calls
- Modify: `tests/xrpc_server.spec.ts` — extend existing executor tests with reporting + sanitization assertions

**Why this exists:** Plan 03 left two `// ERROR-REPORTING SEAM (Plan 04)` comment-anchors in the executor — one in the procedure/query catch block, one in `wrapSubscriptionIterator`. Plan 04 fills them in with the consumer's `ExceptionHandler` lifecycle: `if (shouldReport) await handler.report(err, ctx)` followed by `throw await handler.handle(err, ctx)`. The returned `XrpcError` from `handle()` is what atcute wire-encodes — handler-side errors get the consumer's sanitization (default: env-aware) before they reach the client.

The catch block's previous Plan 03 behavior (wrap non-`XrpcError` in `InternalServerError` and re-throw) is now subsumed by `handler.handle()` — the base `ExceptionHandler` does exactly that wrapping. The executor catch becomes simpler: just delegate to the handler. When no handler is registered (tests, consumers who haven't set up `start/kernel.ts` yet), fall back to the previous Plan 03 inline wrap so the wire response is still well-formed.

Reporting is wrapped in its own try/catch — if the consumer's reporter throws (Sentry network failure, etc.), log the secondary failure but proceed with `handle()` so the original error still gets sanitized and re-thrown. Reporter bugs never mask the wire response.

After successfully running `handle()`, the executor stamps the returned `XrpcError` with the `REPORTED` symbol (from `src/xrpc_service.ts`) so atcute's `handleException` hook (Task 4) knows the consumer's handler already ran and skips a duplicate invocation.

**Steps:**

- [ ] **Step 1: Widen the `deps` type and remove the seam comment**

In `src/xrpc_server.ts`, locate `export function createXrpcExecutor(deps: { operations, serializer })` and change it to:

```ts
import { XrpcService, REPORTED } from './xrpc_service.js'

export function createXrpcExecutor(deps: {
  operations: ReadonlyMap<string, RouteInfo>
  serializer: XrpcSerializer
  xrpc: XrpcService
}): SharedXrpcExecutor {
  const { operations, serializer, xrpc } = deps
  // ... rest of the closure unchanged
}
```

The `// ERROR-REPORTING SEAM (Plan 04)` comment on the deps type goes away — the field is now real.

- [ ] **Step 2: Replace the procedure/query catch-block seam**

Inside the executor's outer try/catch (the one wrapping the handler invocation for procedure/query), locate the `// ERROR-REPORTING SEAM (Plan 04)` comment and replace it (plus the surrounding Plan 03 fallback-wrap logic) with:

```ts
} catch (err) {
  throw await runConsumerHandler(xrpc, err, xrpcCtx)
}
```

Add the `runConsumerHandler` helper as a free function in `src/xrpc_server.ts`:

```ts
import { XrpcError, InternalServerError } from './errors.js'
import type { XrpcContext } from './context.js'
import type { XrpcLexicon } from './types.js'

/**
 * Run the consumer's registered ExceptionHandler against an error. Used
 * by both the procedure/query executor catch and the subscription wrapper
 * catch — single source of truth for the report → handle → mark sequence.
 *
 * Returns the XrpcError the caller should throw. Stamps the `REPORTED`
 * symbol so atcute's `handleException` / `handleSubscriptionException`
 * hooks (Plan 04 Task 4) skip a duplicate handler invocation.
 *
 * Fallback (no handler registered): wrap non-XrpcError as
 * InternalServerError with `{ cause }` — preserves the Plan 03 default
 * for tests and consumers who haven't wired `start/kernel.ts` yet.
 */
async function runConsumerHandler(
  xrpc: XrpcService,
  err: unknown,
  xrpcCtx: XrpcContext<XrpcLexicon>
): Promise<XrpcError> {
  const handler = await xrpc.getRegisteredErrorHandler()

  if (handler) {
    // Reporting first — fire-and-forget for the wire response. A reporter
    // that throws gets logged but doesn't mask the original error.
    if (handler.shouldReport(err)) {
      try {
        await handler.report(err, xrpcCtx)
      } catch (reportErr) {
        xrpcCtx.logger.error(
          { err: reportErr },
          'XRPC ExceptionHandler.report() itself threw — proceeding with handle()'
        )
      }
    }

    // Sanitization — the returned XrpcError is what gets wire-encoded.
    const sanitized = await handler.handle(err, xrpcCtx)
    ;(sanitized as any)[REPORTED] = true
    return sanitized
  }

  // No handler registered — fall back to the Plan 03 default wrap.
  const fallback =
    err instanceof XrpcError
      ? err
      : new InternalServerError(err instanceof Error ? err.message : String(err), { cause: err })
  ;(fallback as any)[REPORTED] = true
  return fallback
}
```

Notes:

- `handler.shouldReport(err)` is a method-call (no `?.`) because `ExceptionHandler` defines `shouldReport()` concretely with a default return of `true`. Consumers who want to suppress override it.
- The `REPORTED` stamp goes on even in the fallback path — that way atcute's hook (which can't tell whether we already ran a handler or just wrapped inline) still skips correctly.

- [ ] **Step 3: Replace the subscription catch-block seam in `wrapSubscriptionIterator`**

In `src/xrpc_server.ts`'s `wrapSubscriptionIterator`, locate the `// ERROR-REPORTING SEAM (Plan 04)` comment in the catch block. Replace it with:

```ts
} catch (err) {
  const xrpcError = await runConsumerHandler(xrpc, err, xrpcCtx)

  // Translate XrpcError → XRPCSubscriptionError for atcute's
  // handleSubscriptionException hook (configured in Task 4). The
  // sanitized XrpcError from runConsumerHandler carries the wire-shape
  // `errorName` + `message` we want.
  throw new XRPCSubscriptionError({
    error: xrpcError.errorName,
    message: xrpcError.message,
  })
}
```

`wrapSubscriptionIterator` needs `xrpc` in scope. Add it as a third positional parameter (after `iterable` and `xrpcCtx`, before `serializer`), and have the executor's subscription branch pass it through:

```ts
// In createXrpcExecutor's subscription branch:
return wrapSubscriptionIterator(userIterable, xrpcCtx, xrpc, serializer)
```

```ts
async function* wrapSubscriptionIterator(
  iterable: AsyncIterable<unknown>,
  xrpcCtx: XrpcContext<XrpcLexicon>,
  xrpc: XrpcService,
  serializer: XrpcSerializer
) {
  // ... existing body, with the catch block above replacing the Plan 03 seam
}
```

Order rationale: `iterable` and `xrpcCtx` are the per-call inputs; `xrpc` and `serializer` are per-app deps. Per-call first, per-app last — matches the executor's own argument grouping.

Note: the `XRPCSubscriptionError` translation stays here (not inside `runConsumerHandler`) because it's subscription-specific — atcute expects this wrapper shape for subscription wire frames, but procedure/query throws the raw `XrpcError` directly.

- [ ] **Step 4: Update tests in `tests/xrpc_server.spec.ts`**

Add new tests to the existing executor test group:

```ts
import { ExceptionHandler } from '../src/exception_handler.js'
import { XrpcService } from '../src/xrpc_service.js'

test('procedure handler error: report() fires + handle()-returned XrpcError is thrown', async ({
  assert,
}) => {
  // Register an XrpcService with a custom ExceptionHandler subclass whose
  // report() pushes onto an array and whose handle() returns a known
  // XrpcError. Construct createXrpcExecutor with that service. Invoke a
  // route whose handler throws. Assert:
  //   - report() captured the error + the XrpcContext
  //   - the thrown error from the executor === the XrpcError handle() returned
  //   - the thrown error carries the REPORTED symbol
})

test('subscription handler error: report() fires + XRPCSubscriptionError wraps the sanitized error', async ({
  assert,
}) => {
  // Same shape for the subscription path. Assert the thrown wrapper is
  // XRPCSubscriptionError and that its `error` / `message` match the
  // sanitized XrpcError's `errorName` / `message`.
})

test('falls back to InternalServerError wrap when no handler is registered', async ({ assert }) => {
  // Construct XrpcService with no errorHandler registered. Invoke a route
  // whose handler throws a plain Error. Assert the thrown error is an
  // InternalServerError with `cause` preserved (Plan 03 default behavior).
})

test('reporter throw does not mask the sanitized error', async ({ assert }) => {
  // Register a handler whose report() throws. Invoke a route whose handler
  // throws. Assert:
  //   - the thrown error is the XrpcError handle() returned (NOT the
  //     reporter's exception)
  //   - the logger received a warning about the reporter failure
})
```

The setupApp shape and the `createXrpcExecutor` invocation pattern are already established in Plan 03's `tests/xrpc_server.spec.ts` — copy and extend, don't reinvent.

- [ ] **Step 5: Update `createXrpcExecutor` call sites in existing Plan 03 tests**

Plan 03's tests construct `createXrpcExecutor({ operations, serializer })` directly. They now need to pass `xrpc`. Update those sites:

```ts
// In tests that construct createXrpcExecutor directly:
import { XrpcService } from '../src/xrpc_service.js'
// ...
const xrpc = new XrpcService(app)
const executor = createXrpcExecutor({ operations, serializer, xrpc })
```

No handler registration is needed for tests that don't care about error reporting — `getRegisteredErrorHandler()` returns null and the executor falls back to the inline wrap.

The provider's `ready()` (Task 4) passes `xrpc` from the resolved container binding.

- [ ] **Step 6: Run tests to verify pass**

Run: `pnpm quick:test --files tests/xrpc_server.spec.ts`

Expected: all existing Plan 03 executor tests still pass + the 4 new tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/xrpc_server.ts tests/xrpc_server.spec.ts
git commit -m "feat: run consumer ExceptionHandler from executor + subscription wrapper"
```

---

## Task 4: Expand `XrpcProvider` (bind XrpcService + wire atcute hooks)

**Files:**

- Modify: `providers/provider.ts` — expand `boot()` to bind `XrpcService` alongside the existing `XrpcRouter` binding; expand `ready()` to construct atcute's `XRPCRouter` with `handleException` + `handleSubscriptionException` hooks and to pass `xrpc` into `createXrpcExecutor`'s deps
- Modify: `tests/provider.spec.ts` — extend Plan 03 Task 7b's provider tests with the new bindings + ready-phase atcute hook verification

**Why this exists:** Plan 03 Task 7b shipped a minimal provider whose only jobs were (a) bind `XrpcRouter` + install `router.xrpc` macro + commit the router and (b) construct + start `XrpcServer`. Plan 04 expands those hooks with the consumer-facing surface: `XrpcService` (consumer registers exception handlers against it via `services/xrpc`), and atcute's `handleException` / `handleSubscriptionException` hooks (so atcute-internal errors — not just handler errors — flow through the same `ExceptionHandler`).

**Why both atcute hooks AND the executor seam reporting?** Two distinct error origins:

1. **Handler errors** — thrown from the user's `handle(ctx)` or yielded-from generator. These traverse the executor's try/catch and `wrapSubscriptionIterator`'s catch. Both invoke `runConsumerHandler` (Task 3) which calls `handler.report()` + `handler.handle()`, stamps the returned `XrpcError` with `REPORTED`, and re-throws.
2. **Atcute-internal errors** — thrown during request parsing, route matching, input/output validation, lexicon assertion. These don't traverse the executor's try/catch — atcute catches them itself and routes to `handleException` / `handleSubscriptionException`. Without wiring those hooks, these errors get atcute's default wire encoding but are NEVER seen by the consumer's `ExceptionHandler` — silent observability gap, no consumer-controlled sanitization.

Task 4 closes the gap. Both paths converge on a single `makeAtcuteHook(xrpc)` helper (used for both atcute hook positions); it skips when the error carries `REPORTED` (handler-side errors already ran the consumer handler in the executor catch), and otherwise runs `runConsumerHandler` just like the executor catch would.

**Steps:**

- [ ] **Step 1: Expand `providers/provider.ts`**

The minimal provider from Plan 03 Task 7b already has `register()` (binds the `XrpcRouter` singleton + `xrpcRouter` alias) and `boot()` (installs the `router.xrpc` accessor on `Router.prototype`). Plan 04 adds a second container binding into `register()` for the `XrpcService` facade — the install mechanism for `router.xrpc` itself is unchanged from Plan 03 and doesn't need to be restated here.

```ts
import { XRPCRouter } from '@atcute/xrpc-server'
import { createNodeWebSocket } from '@atcute/xrpc-server-node'
import type { ApplicationService } from '@adonisjs/core/types'
import type { ContainerProviderContract } from '@adonisjs/application/types'

import { XrpcRouter } from '../src/router.js'
import { XrpcServer, createXrpcExecutor } from '../src/xrpc_server.js'
import { XrpcSerializer } from '../src/serializer.js'
import { XrpcService, REPORTED } from '../src/xrpc_service.js'
import { XrpcContext } from '../src/context.js'
import { XrpcError, InternalServerError } from '../src/errors.js'

export default class XrpcProvider implements ContainerProviderContract {
  constructor(protected app: ApplicationService) {}

  register() {
    // --- Plan 03 (unchanged): XrpcRouter binding ---
    this.app.container.singleton(XrpcRouter, () => new XrpcRouter(this.app))
    this.app.container.alias('xrpcRouter', XrpcRouter)

    // --- Plan 04: XrpcService binding ---
    // Bound here so `services/xrpc.ts`'s `app.booted(...)` hook can resolve
    // it. The 'xrpc' alias is what `services/xrpc.ts` resolves against —
    // keep it stable.
    this.app.container.singleton(XrpcService, () => new XrpcService(this.app))
    this.app.container.alias('xrpc', XrpcService)
  }

  async boot() {
    // --- Plan 03 (unchanged): install the router.xrpc accessor on
    // Router.prototype. See Plan 03 Task 7b Step 1 for the mechanism
    // (`Object.defineProperty(Router.prototype, 'xrpc', ...)` — `Router`
    // isn't `Macroable` so neither `Router.macro` nor `Router.getter` is
    // available). Plan 04 doesn't add anything to boot().
    // ... (keep the existing inline body verbatim) ...
  }

  async start() {
    // --- Plan 03 (unchanged): commit the XrpcRouter ---
    const xrpcRouter = await this.app.container.make('xrpcRouter')
    xrpcRouter.commit()
  }

  async ready() {
    if (this.app.getEnvironment() !== 'web') return

    const xrpcRouter = await this.app.container.make('xrpcRouter')
    const xrpc = await this.app.container.make('xrpc')

    const ws = createNodeWebSocket()

    // --- Plan 04: atcute hooks for observability of atcute-internal errors
    // that don't traverse our executor's try/catch. Both hooks delegate to
    // the same `makeAtcuteHook` because the consumer's single
    // `ExceptionHandler.handle()` covers both paths — the consumer
    // discriminates with `ctx?.lexicon.type` if they care.
    // ---
    const atcuteHook = makeAtcuteHook(xrpc)
    const atcuteRouter = new XRPCRouter({
      websocket: ws.adapter,
      handleException: atcuteHook,
      handleSubscriptionException: atcuteHook,
    })

    // --- Plan 03 widened (Plan 04): pass xrpc into the executor deps so
    // the catch blocks can run the consumer's ExceptionHandler ---
    const executor = createXrpcExecutor({
      operations: xrpcRouter.operations,
      serializer: new XrpcSerializer(),
      xrpc,
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

  // shutdown() lands in Task 5.
}

/**
 * Build the atcute hook used for both `handleException` and
 * `handleSubscriptionException`. Single helper — the consumer's
 * `ExceptionHandler.handle()` covers both paths.
 *
 * Two responsibilities:
 *
 * 1. Run the consumer's registered ExceptionHandler against the error so
 *    that atcute-internal errors (request parsing, lexicon assertion,
 *    route matching) — which don't traverse our executor's try/catch —
 *    still reach the consumer's reporter and sanitizer.
 *
 * 2. Throw the sanitized XrpcError so atcute's wire encoder produces a
 *    well-formed response body. atcute uses the thrown value directly.
 *
 * **Dedup** (REPORTED symbol): handler-side errors enter our executor
 * catch FIRST. The executor calls `handler.report` + `handler.handle`,
 * stamps the returned XrpcError with `REPORTED`, and throws — atcute
 * then sees the (already-sanitized) XrpcError and calls THIS hook. We
 * check the symbol and short-circuit so reporting/handling isn't
 * duplicated. Errors raised inside atcute before reaching our executor
 * have no `REPORTED` stamp and get the full handler invocation here.
 *
 * **XrpcContext.get()** returns the active context (HTTP path: executor
 * had already entered the ALS; subscription path: each .next() runs
 * inside als.run). Atcute-internal errors raised before the executor
 * runs have no XrpcContext — `get()` returns undefined and we pass null
 * to the consumer's handler.
 */
function makeAtcuteHook(xrpc: XrpcService) {
  return async (err: unknown): Promise<never> => {
    if ((err as any)?.[REPORTED]) {
      throw err
    }

    const handler = await xrpc.getRegisteredErrorHandler()
    if (!handler) {
      // No handler registered (tests, consumers who haven't wired
      // start/kernel.ts yet). Mirror runConsumerHandler's fallback so
      // atcute still gets a well-formed XrpcError.
      const fallback =
        err instanceof XrpcError
          ? err
          : new InternalServerError(err instanceof Error ? err.message : String(err), {
              cause: err,
            })
      ;(fallback as any)[REPORTED] = true
      throw fallback
    }

    const xrpcCtx = XrpcContext.get() ?? null

    if (handler.shouldReport(err)) {
      try {
        await handler.report(err, xrpcCtx)
      } catch {
        // Swallow reporter failures so the original error still gets
        // sanitized and re-thrown for atcute to encode.
      }
    }

    const sanitized = await handler.handle(err, xrpcCtx)
    ;(sanitized as any)[REPORTED] = true
    throw sanitized
  }
}
```

- [ ] **Step 2: Write expanded provider tests**

Extend `tests/provider.spec.ts` with one new test for the XrpcService binding (the atcute-hook wiring is covered end-to-end by Task 6's functional tests — exposing internal atcute router options for unit-level introspection isn't the right direction):

```ts
test('boot() binds XrpcService as a container singleton', async ({ assert }) => {
  const { app } = await setupApp({
    rcFileContents: { providers: [() => import('../providers/provider.js')] },
  })
  const xrpc = await app.container.make('xrpc')
  assert.instanceOf(xrpc, XrpcService)

  const xrpc2 = await app.container.make('xrpc')
  assert.strictEqual(xrpc, xrpc2, 'singleton — same instance on repeated resolution')
})
```

- [ ] **Step 3: Run tests to verify pass**

Run: `pnpm quick:test --files tests/provider.spec.ts`

Expected: all existing Plan 03 provider tests still pass + the new XrpcService binding test passes.

- [ ] **Step 4: Commit**

```bash
git add providers/provider.ts tests/provider.spec.ts
git commit -m "feat: expand provider with XrpcService binding + atcute exception hooks"
```

(`src/xrpc_service.ts`'s `REPORTED` symbol export was already added in Task 1; `src/xrpc_server.ts`'s `runConsumerHandler` + `REPORTED` stamp were added in Task 3. No further edits to those files in this task.)

---

## Task 5: `XrpcServer.shutdown()` + provider `shutdown()` hook — graceful WebSocket teardown

**Files:**

- Modify: `src/xrpc_server.ts` — add `#shuttingDown` private field; modify `#installWebSocketHandler`'s upgrade wrapper to no-op when `#shuttingDown`; add `XrpcServer.shutdown(graceMs?)` method
- Modify: `providers/provider.ts` — add `shutdown()` method that delegates to `XrpcServer.shutdown()`
- Create: `tests/provider_shutdown.spec.ts` — exercise the close-frame send + grace period + force-terminate fallback

**Why this exists:** Adonis's graceful-shutdown machinery drains in-flight HTTP requests but doesn't touch WebSocket connections. Without an explicit `shutdown()`, on SIGTERM / dev-reload:

1. The HTTP server closes; in-flight HTTP requests get the grace window and finish.
2. WS connections don't receive a close frame. Clients hang until their next ping fails (typically 30s).
3. Subscription async-generator handlers keep running until the Node process is killed — DB connections held, transaction-log watchers still pulling, etc.
4. On rolling deploys behind a load balancer: reconnect storms when old clients all re-handshake to the new pod simultaneously after their ping timeouts.

The shutdown sequence: stop accepting new upgrades → send 1001 (Going Away) to all connected clients → wait briefly for graceful disconnects → force-terminate survivors.

**`graceMs` configuration**: hardcoded at 3000ms (3 seconds) for this plan. Rationale: this is well-trodden territory — Kubernetes' default `terminationGracePeriodSeconds` is 30s, of which the SIGTERM-to-SIGKILL window is most; 3s of that going to WS drain leaves plenty for the HTTP-side drain. A consumer with unusual subscription handler patterns (e.g. very long-running per-message processing that the abort signal can't interrupt mid-flight) might want to tune this — when that consumer turns up, we add `defineConfig({ shutdownGraceMs: 5000 })` as a non-breaking field. Until then, hardcoded keeps the config surface narrow.

**Why provider `shutdown()` runs before Adonis's HTTP server `.close()`:** verified in the pre-flight checks. Per Adonis 7.x's `Application.terminate()` flow, provider `shutdown()` hooks fire first, then the HTTP server closes. This is what gives our 1001 close-frame loop time to reach clients before the underlying TCP socket dies. If the pre-flight check found the ordering is reversed, this task needs a different approach (likely a process `SIGTERM` listener registered in `ready()` that pre-empts the shutdown sequence) — write that variant in the catch-up notes below.

**Steps:**

- [ ] **Step 1: Add `#shuttingDown` field + thread it into the upgrade wrapper**

In `src/xrpc_server.ts`, on the `XrpcServer` class:

```ts
export class XrpcServer {
  #shuttingDown = false
  // ... existing fields ...

  /**
   * The upgrade wrapper installed by `#installWebSocketHandler`. Modified
   * in Plan 04 Task 5 to consult `#shuttingDown` first — when the provider's
   * `shutdown()` flips this flag, in-flight upgrade negotiations are
   * rejected so new clients don't connect during the grace window.
   */
  #upgradeListener = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (this.#shuttingDown) {
      // Reject the upgrade by destroying the socket. The handshake hasn't
      // completed yet, so there's no WebSocket frame to send — destroying
      // the underlying TCP socket is the right signal. The client sees
      // ECONNRESET and should retry against the new pod (post-shutdown).
      socket.destroy()
      return
    }
    // ... existing wrapper body from Plan 03 Task 6 ...
  }
}
```

If Plan 03 inlined the upgrade wrapper as an arrow function passed to `server.on('upgrade', ...)`, lift it into a named class field as shown above so the `#shuttingDown` check has a clear home. The Plan 03 listener-count delta guard (verifying we snipped exactly atcute's one listener) doesn't need changes.

- [ ] **Step 2: Implement `XrpcServer.shutdown(graceMs?)`**

```ts
async shutdown(graceMs = 3000): Promise<void> {
  this.#shuttingDown = true

  // No connected clients — nothing to drain. Skip both the close-frame
  // loop and the wait.
  if (this.#ws.wss.clients.size === 0) return

  // 1. Send 1001 'going away' to every connected client. Clients see the
  // close frame and exit their read loops cleanly rather than waiting for
  // ping timeout. Snapshot to Array.from before iterating — calling
  // .close() on a client may synchronously remove it from `wss.clients`,
  // which would skew direct iteration.
  for (const client of Array.from(this.#ws.wss.clients)) {
    try {
      client.close(1001, 'server shutting down')
    } catch {
      // Already closed / closing — ignore.
    }
  }

  // 2. Wait briefly for clients to ack the close. Each ack triggers the
  // socket's 'close' event which removes it from `wss.clients`. We poll
  // because there's no single 'all-closed' event on WebSocketServer.
  await waitForAllClientsClosed(this.#ws.wss, graceMs)

  // 3. Force-terminate any survivors. .terminate() is `ws`'s hard-close:
  // doesn't send a frame, just kills the underlying TCP socket. Survivors
  // are either misbehaving clients that ignored the close frame or
  // subscription handlers stuck in a non-cancelable operation that's
  // holding the iterator open past the grace window.
  for (const client of Array.from(this.#ws.wss.clients)) {
    try {
      client.terminate()
    } catch {
      // Already terminated — ignore.
    }
  }
}
```

Add the helper outside the class (or in a private static):

```ts
async function waitForAllClientsClosed(wss: WebSocketServer, graceMs: number): Promise<void> {
  if (wss.clients.size === 0) return
  return new Promise((resolve) => {
    const start = Date.now()
    const check = () => {
      if (wss.clients.size === 0) return resolve()
      if (Date.now() - start >= graceMs) return resolve()
      setTimeout(check, 50).unref()
    }
    check()
  })
}
```

Notes:

- `.unref()` on the timeout prevents the poll from holding the process open if `shutdown()` is called and the timer is still alive when the rest of the app has cleared down — Node's event loop exits when only `.unref()`'d timers remain.
- The 50ms poll interval is a balance: tight enough to catch fast acks (typical close round-trips are 5–20ms on localhost, 30–100ms on real networks), loose enough not to spin uselessly. Don't micro-tune.
- Aborts: this plan does NOT add an explicit `AbortController`-per-subscription tracked on `XrpcServer`. atcute's WebSocket adapter wires the per-connection signal into the `XrpcContext.signal` already (Plan 03 Task 4 verified this against atcute trunk); when the underlying socket closes (either from our 1001 frame or from `.terminate()`), atcute fires that signal, which causes well-behaved handler generators to exit their `for await` loops. If a handler doesn't honor the signal (e.g. it's blocked in a `await someInfiniteDbCall()` with no `signal` parameter), it stays stuck — `.terminate()` only kills the socket; it doesn't unwind the JS generator. That's a handler bug, not something this layer can fix.

- [ ] **Step 3: Add `shutdown()` to the provider**

In `providers/provider.ts`:

```ts
async shutdown() {
  if (this.app.getEnvironment() !== 'web') return
  const xrpcServer = await this.app.container.make(XrpcServer)
  await xrpcServer.shutdown()
}
```

The env gate matches `ready()` — outside web envs (`console` / `test`), `XrpcServer` was never bound, so resolving it would throw `RuntimeException` from the container. The gate avoids that.

- [ ] **Step 4: Write `tests/provider_shutdown.spec.ts`**

```ts
import { test } from '@japa/runner'
import { setTimeout as sleep } from 'node:timers/promises'
import { setupApp } from './helpers.js'
import { injectXrpcSubscription } from '../src/test_utils.js'
import { XrpcServer } from '../src/xrpc_server.js'

test.group('XrpcServer.shutdown() — graceful WS teardown', () => {
  test('sends 1001 close frame to connected subscription clients', async ({ assert }) => {
    // Setup: spin up a real server with one subscription route registered.
    // Open a subscription via injectXrpcSubscription (Plan 03 Task 9).
    // Assert the connection is open. Trigger shutdown. Assert the client
    // received a 1001 close frame and the iterator returned cleanly.
    //
    // Use the subscription-fixture pattern from Plan 03 Task 10 — same
    // setupApp shape, same subscription route registration. The new bit
    // is calling `xrpcServer.shutdown()` and observing the close frame
    // on the client side via injectXrpcSubscription's close-event hook.
  })

  test('rejects new upgrades after shutdown starts', async ({ assert }) => {
    // Setup: open one subscription, start shutdown (don't await), try to
    // open a second subscription mid-grace-window. Assert the second
    // attempt fails with ECONNRESET.
  })

  test('force-terminates surviving clients after grace window', async ({ assert }) => {
    // Setup: open a subscription whose handler ignores the close frame
    // (a handler whose generator body blocks on a non-cancelable promise).
    // Trigger shutdown with a short graceMs (e.g. 200ms). Assert the
    // socket is .terminate()'d after the window, observable via the
    // client's 'close' event firing without the clean 1001 code (1006
    // — abnormal closure — is the typical ws-side code for a TCP RST).
  })

  test('no-op when no clients are connected', async ({ assert }) => {
    const { app } = await setupApp({
      rcFileContents: { providers: [() => import('../providers/provider.js')] },
    })
    const xrpcServer = await app.container.make(XrpcServer)
    // shutdown() should return promptly without throwing
    const start = Date.now()
    await xrpcServer.shutdown()
    assert.isBelow(Date.now() - start, 100, 'shutdown should not wait when no clients connected')
  })
})
```

The first three tests need `injectXrpcSubscription` (Plan 03 Task 9) to drive the WS side. The shutdown-trigger options:

- **Preferred**: call `xrpcServer.shutdown()` directly. This is the unit-of-work boundary and exercises the same code path as `app.terminate()` would.
- **Alternative**: call `app.terminate()` (Adonis's app-level teardown). Higher-fidelity but slower and couples the test to Adonis's `terminate()` semantics. Skip unless the direct-call path stops being representative.

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm quick:test --files tests/provider_shutdown.spec.ts`

Expected: all 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/xrpc_server.ts providers/provider.ts tests/provider_shutdown.spec.ts
git commit -m "feat: graceful WebSocket teardown on shutdown"
```

---

## Task 6: Functional tests — error reporting end-to-end (HTTP + subscription)

**Files:**

- Create: `tests/provider_error_reporting.spec.ts` — register a real `ExceptionHandler` subclass via `xrpc.errorHandler(...)`; trigger errors from procedure handlers, subscription handlers, and atcute-internal paths; assert both `report()` was called AND `handle()`'s returned `XrpcError` is what the wire response encodes

**Why functional tests here rather than only unit tests:** Tasks 1, 3, and 4 each have unit-level tests for their own pieces (XrpcService factory storage; executor catch-block reporting; provider bindings). What those don't verify is that the WHOLE PATH works end-to-end: a real HTTP request hits the dispatch middleware, fires through atcute's router, enters the executor, the handler throws, the executor's catch invokes `runConsumerHandler` (which calls `handler.report()` + `handler.handle()`), atcute wire-encodes the returned `XrpcError`, the client sees a well-formed response. Plus the atcute-internal branch — sending a request that fails atcute's own validation (not the handler's) and seeing the consumer's handler fire via `handleException`.

**Steps:**

- [ ] **Step 1: Implement `tests/provider_error_reporting.spec.ts`**

```ts
import { test } from '@japa/runner'
import { setupApp } from './helpers.js'
import { ExceptionHandler } from '../src/exception_handler.js'
import { InternalServerError, NotFoundError, XrpcError } from '../src/errors.js'
import type { XrpcContext, XrpcLexicon } from '../src/context.js'

test.group('end-to-end error reporting', () => {
  test('procedure handler throw: report() fires once + handle()-returned XrpcError encoded', async ({
    assert,
  }) => {
    const reportCalls: Array<{ err: unknown; ctx: XrpcContext<XrpcLexicon> | null }> = []
    class SpyHandler extends ExceptionHandler {
      async report(err: unknown, ctx: XrpcContext<XrpcLexicon> | null) {
        reportCalls.push({ err, ctx })
      }
      async handle(err: unknown, ctx: XrpcContext<XrpcLexicon> | null): Promise<XrpcError> {
        // Custom sanitization: always convert to NotFoundError for this test
        return new NotFoundError('sanitized in handle()')
      }
    }

    const { app } = await setupApp({
      rcFileContents: { providers: [() => import('../providers/provider.js')] },
      beforeReady: async (app) => {
        const router = await app.container.make('router')
        router.xrpc.procedure(
          { id: 'com.example.fail', type: 'xrpc_procedure', defs: { main: {} } } as any,
          () => {
            throw new Error('internal boom')
          }
        )
        const xrpc = await app.container.make('xrpc')
        xrpc.errorHandler(async () => ({ default: SpyHandler }))
      },
    })

    // `setupApp` returns `{ testUtils, app, terminate }` — resolve the server
    // from the container the same way Plan 03 Task 8 does. (See pre-existing
    // `tests/helpers.ts` for the fixture's return shape.)
    const server = await app.container.make('server')
    const response = await server.inject({
      method: 'POST',
      url: '/xrpc/com.example.fail',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    // Reporting fired exactly once (no double-fire from atcute's hook)
    assert.lengthOf(reportCalls, 1, 'reporter fired exactly once (REPORTED-symbol dedup)')
    assert.equal((reportCalls[0].err as Error).message, 'internal boom')
    assert.property(reportCalls[0].ctx, 'lexicon')

    // Wire response carries the SANITIZED error (NotFoundError), not the
    // raw "internal boom" message. Proves handle() ran and its return value
    // flowed all the way to atcute's wire encoder.
    const body = JSON.parse(response.body)
    assert.equal(body.error, 'NotFound') // NotFoundError.errorName
    assert.equal(body.message, 'sanitized in handle()')
  })

  test('subscription handler throw: report() fires + handle()-returned error wraps to XRPCSubscriptionError', async ({
    assert,
  }) => {
    // ... same shape, with a subscription route whose generator throws
    //     mid-iteration. Open the subscription via injectXrpcSubscription
    //     (Plan 03 Task 9). Assert the spy's report fired once, AND the
    //     error frame the client receives carries the `errorName` /
    //     `message` from the SpyHandler's handle() return value.
    //     ctx.lexicon.type === 'xrpc_subscription' inside the handler body
    //     (test that the discriminator is reachable).
  })

  test('atcute-internal error (malformed request body) is reported via the atcute hook', async ({
    assert,
  }) => {
    // Register the spy handler. Send a POST to a route that exists but with
    // a body atcute rejects at parse time (before our executor materializes
    // an XrpcContext). Assert:
    //   - report() fired (atcute hook ran the consumer's handler)
    //   - report() received ctx = null (no XrpcContext was active)
    //   - the wire response carries the sanitized error from handle()
    //
    // If atcute auto-encodes a wire response without invoking
    // handleException for parse failures (verify against the trunk source
    // during pre-flight check #4), narrow the test to a different
    // atcute-internal trigger: send a request whose Content-Type is missing
    // but required, or whose URL is `/xrpc/` with no NSID.
  })

  test('no handler registered: wire response still well-formed (Plan 03 fallback)', async ({
    assert,
  }) => {
    // No xrpc.errorHandler registration. Procedure handler throws plain Error.
    // Assert the wire response is the InternalServerError wrap (Plan 03
    // fallback semantics preserved when consumer hasn't set up handler).
  })

  test('reporter throw does not mask original error', async ({ assert }) => {
    // Register a handler whose report() throws. Send a request that
    // triggers a handler error. Assert the wire response still encodes
    // the ORIGINAL error (not the reporter's), and the logger received
    // a warning about the reporter failure.
  })
})
```

The `server.inject` API — pre-flight check should confirm we're using `light-my-request` (per the user's memory `testing-prefer-injection-over-real-ports`) or AdonisJS's built-in test-utils HTTP injector. Match Plan 03 Task 8's pattern.

- [ ] **Step 2: Run all new functional tests**

Run: `pnpm quick:test --files 'tests/provider_*.spec.ts'`

Expected: all tests pass. If any atcute-internal-error test fails because the pre-flight check (handleException invocation conditions) found different behavior than the spec assumed, adjust the test trigger per the finding from pre-flight check #4.

- [ ] **Step 3: Commit**

```bash
git add tests/provider_error_reporting.spec.ts
git commit -m "test: end-to-end coverage for error reporting"
```

---

## Task 7: Public exports + tsdown.entry + `services/xrpc` subpath

**Files:**

- Modify: `index.ts` — add `XrpcService` type export (the `ExceptionHandler` class itself ships in Plan 01)
- Modify: `package.json` — add `./services/xrpc` to both `exports` and `tsdown.entry`

**Why this exists:** `XrpcService` is a public type (consumers may want to type their kernel.ts imports against it, even though they usually don't need to — `xrpc.errorHandler(...)` works untyped). The `./services/xrpc` subpath is the import target for `start/kernel.ts`. Neither is usable until they're in `exports`. The `ExceptionHandler` base class itself is already exported from `index.ts` by Plan 01 Task 10.

**Steps:**

- [ ] **Step 1: Add type export to `index.ts`**

Append to `index.ts`:

```ts
export type { XrpcService } from './src/xrpc_service.js'
```

Type-only — the runtime `XrpcService` class isn't directly constructible by consumers (they get a singleton via `services/xrpc.ts`), so re-exporting the class itself would invite consumer code that does `new XrpcService(app)` for no reason. Type-only export keeps the type accessible for annotations without the runtime confusion. (`ExceptionHandler` was already re-exported as a runtime class by Plan 01 Task 10 — don't re-add.)

- [ ] **Step 2: Verify `./services/xrpc` is in `package.json#exports`**

The `./services/xrpc` subpath is added by Plan 01 (Task 10 — the file is scaffolded from the initial commit, and Plan 01 wires up the export entry). Plan 04 fills in the accessor body (Task 2 above) but doesn't need to touch the export map. Verify the entry is present:

```bash
jq '.exports["./services/xrpc"]' package.json
```

Expected: a non-null value pointing at `./build/services/xrpc.js`. If absent (Plan 01 not executed yet or its Task 10 was skipped), add it here.

- [ ] **Step 3: Verify `./services/xrpc.ts` is in `tsdown.entry`**

In `package.json#tsdown.entry`:

```jsonc
{
  "tsdown": {
    "entry": [
      "index.ts",
      "configure.ts",
      "services/xrpc.ts",          // present from Plan 01 Task 10
      "src/middleware/dispatch.ts",
      "src/test_utils.ts",
      "src/event-stream/framing.ts"
    ],
    ...
  }
}
```

Verify with: `jq '.tsdown.entry | index("services/xrpc.ts")' package.json` — expected: a non-null index. If absent, add it here.

- [ ] **Step 4: Verify build produces the expected output structure**

Run: `pnpm build`

Verify: `build/services/xrpc.js` and `build/services/xrpc.d.ts` exist after build.

- [ ] **Step 5: Verify `attw` is happy with the type shape**

Run: `pnpm types:check`

Expected: PASS. If `attw` complains about the new subpath, the most likely culprit is the `types` / `import` ordering in `exports` (types must come first in conditional exports). Fix and re-run.

- [ ] **Step 6: Commit**

```bash
git add index.ts package.json
git commit -m "feat: expose XrpcService types + services/xrpc subpath"
```

---

## Task 8: Changeset entry

**Files:**

- Create: `.changeset/<auto-generated-slug>.md`

**Why this exists:** The release pipeline (changesets + npm OIDC, per `CLAUDE.md` § _Releasing_) requires a changeset for every user-facing change. Plan 04 ships a substantial public surface expansion (`XrpcService`, `services/xrpc` subpath, provider lifecycle expansion, graceful WS shutdown) — minor bump on v0.x.

**Steps:**

- [ ] **Step 1: Generate the changeset**

Run: `pnpm changeset`

Walk the prompt:

- Selected package: `@thisismissem/adonisjs-atproto-xrpc`
- Bump type: **minor** (v0.x, new public surface: `./services/xrpc` subpath, `XrpcService` type, provider lifecycle expansion, graceful WS shutdown)
- Summary: `Expand XrpcProvider with the XrpcService facade — register an ExceptionHandler subclass via xrpc.errorHandler(() => import('#exceptions/xrpc_handler')) from start/kernel.ts (mirroring server.errorHandler from @adonisjs/core/services/server). The single registration covers both procedure/query and subscription paths; consumers branch on ctx?.lexicon.type inside their handle() body when path-specific behavior is needed. atcute's handleException + handleSubscriptionException are wired so atcute-internal errors (parse failures, lexicon assertion) flow through the same consumer handler as handler-side errors — REPORTED-symbol dedupe prevents double-invocation when both paths see the same error. Provider shutdown() drains in-flight WebSocket subscriptions with a 1001 close frame and a 3s grace window before .terminate()ing survivors — clients disconnect cleanly on SIGTERM / dev-reload instead of hanging until ping timeout. (Spec § "Container bindings — HttpContext.xrpc" was deliberately dropped — see the plan document for why.)`

- [ ] **Step 2: Commit the changeset**

```bash
git add .changeset/
git commit -m "chore: changeset for provider expansion"
```

---

## Self-review

Run through this checklist before handing off:

- [ ] **Spec coverage:** Each item from the spec's _XrpcService facade_, _Lifecycle phases_, _Error reporting (procedure/query and subscription)_, and _Kernel registrations_ sections has a task above (or is explicitly out of scope / deliberately collapsed).
  - `XrpcService` class with single `errorHandler` registration + lazy resolution + memoization — Task 1 ✓
  - `services/xrpc.ts` singleton accessor (mirroring `@adonisjs/core/services/server`) — Task 2 ✓
  - Executor + subscription-wrapper catch blocks run the consumer's `ExceptionHandler` (`report` + `handle`) via `runConsumerHandler` — Task 3 ✓
  - Provider `boot()` binds XrpcService — Task 4 ✓
  - Provider `ready()` widens atcute XRPCRouter construction with a single `makeAtcuteHook` reused for both `handleException` and `handleSubscriptionException` — Task 4 ✓
  - Provider `ready()` widens executor construction with `xrpc` dep — Task 4 ✓
  - Provider `shutdown()` graceful WS teardown — Task 5 ✓
  - Public exports (`XrpcService` type + `./services/xrpc` subpath; `ExceptionHandler` class from Plan 01) — Task 7 ✓
  - Changeset — Task 8 ✓
  - Spec's `errorHandler` + `subscriptionErrorHandler` split — **deliberately collapsed** to a single `errorHandler` registration; consumer's `ExceptionHandler.handle()` discriminates via `ctx?.lexicon.type` when path-specific behavior is needed. Rationale: see "Single-handler design" in Architecture. The fall-through complexity (`getRegisteredSubscriptionErrorHandler` resolving the regular handler when no subscription one is set) is gone.
  - Spec § _Container bindings — HttpContext.xrpc_ — **intentionally NOT implemented**; rationale in the "Why no HttpContext.xrpc getter" paragraph in Architecture. Future spec-amendment pass should drop the section.

- [ ] **Type consistency:** `ExceptionHandler` (from Plan 01) ships `shouldReport(error): boolean`, `report(error, ctx: XrpcContext<XrpcLexicon> | null): Promise<void>`, and `handle(error, ctx: XrpcContext<XrpcLexicon> | null): Promise<XrpcError>`. `ctx` is nullable because atcute-internal errors fire before the executor materializes an `XrpcContext`. `XrpcService` constructor takes `app: ApplicationService`; `getRegisteredErrorHandler()` returns `Promise<ExceptionHandler | null>`. `createXrpcExecutor`'s `deps` widens to `{ operations, serializer, xrpc: XrpcService }`. `wrapSubscriptionIterator` signature widens to `(iterable, xrpcCtx, xrpc, serializer)`. `runConsumerHandler(xrpc, err, xrpcCtx)` returns `Promise<XrpcError>` and stamps the `REPORTED` symbol on the returned error. `makeAtcuteHook(xrpc)` returns `(err: unknown) => Promise<never>` (always throws). `XrpcServer.shutdown(graceMs?: number): Promise<void>` — `graceMs` defaults to 3000. `XrpcContext.get()` returns `XrpcContext<XrpcLexicon> | undefined` (added via Plan 01 amendment alongside the existing `getOrFail()`).

- [ ] **No placeholder text:** Grep for `TODO`, `FIXME`, `TBD` in the plan. Expected: none. Plan 04's `defineConfig({ shutdownGraceMs })` deferral is documented inline (Task 5 intro) as a deliberate future-addition decision, not a TODO.

- [ ] **No double-report regressions:** The `REPORTED` symbol mechanism is the only thing keeping handler-side errors from being run twice through the consumer's `ExceptionHandler` (once by the executor catch / subscription wrapper catch via `runConsumerHandler`, once by atcute's `handleException` via `makeAtcuteHook`). `runConsumerHandler` stamps the returned `XrpcError` with `REPORTED` before throwing; `makeAtcuteHook` checks for `REPORTED` first and short-circuits. The plan's Task 6 tests cover this via the `assert.lengthOf(reportCalls, 1, 'reporter fired exactly once (REPORTED-symbol dedup)')` assertion. If a refactor changes either the stamp or the check, that assertion catches the regression.

- [ ] **No HttpContext.xrpc references in code or tests:** Grep for `HttpContext.xrpc`, `installHttpContextGetter`, `http_context.ts`, `provider_http_context_xrpc` in the plan. Expected: zero matches in task bodies (the Architecture section and self-review item above intentionally mention them in explanatory text).

- [ ] **No `subscriptionErrorHandler` / `XrpcExceptionHandler` references:** Grep for `subscriptionErrorHandler`, `XrpcExceptionHandler`, `getRegisteredSubscriptionErrorHandler`, `makeHandleException`, `makeHandleSubscriptionException` in Plan 04 task bodies. Expected: zero matches — those names belonged to the previous two-handler-with-fall-through design and the split atcute-hook helpers. The collapsed design uses `ExceptionHandler` (Plan 01), `getRegisteredErrorHandler`, and `makeAtcuteHook`.

- [ ] **No Plan 05 / auth references:** Grep for `XrpcAuth`, `serviceAuth`, `ServiceJwtVerifier`, `Plan 05` in the plan. Expected: zero matches. (Per the implementation-scope note at the top: auth is intentionally absent from this plan series.)

- [ ] **Auth-field passthrough**: `RouteInfo.auth` (from Plan 01's data structure) is carried through the executor unread — same shape as Plan 03. Plan 04 doesn't introduce any new code that reads `route.auth.serviceAuth` or `route.auth.optional`. The atcute hooks (Task 4) read the error, not the route metadata.

- [ ] **Plan 01 amendments landed:** Plan 04 depends on three Plan 01 amendments made during this drafting pass: (1) `XrpcContext.get()` non-throwing accessor (alongside the existing `getOrFail()`), (2) `src/exception_handler.ts` shipping the `ExceptionHandler` base class with env-aware default `handle()`, (3) `stubs/app/exceptions/xrpc_handler.stub` published by the configure command. Verify all three are present in Plan 01 before executing Plan 04. Quick checks: `grep -n 'static get()' src/context.ts`, `ls src/exception_handler.ts`, `ls stubs/app/exceptions/xrpc_handler.stub`.

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-05-25-xrpc-plan-04-provider.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task (Tasks 1–8), review between tasks, fast iteration. The tasks are mostly independent; Task 1 must precede Tasks 2–6, Task 3 must precede Task 6, Task 4 must precede Tasks 5 and 6, Task 5 must precede Task 6 (for the shutdown test fixture). Task 7 can run in parallel with Task 6; Task 8 last. **Before Task 1**: verify the three Plan 01 amendments landed (pre-flight check, last item).

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Either approach: complete the pre-flight checks BEFORE Task 1. Particularly the atcute `XRPCRouterOptions` shape verification (#4) — it's the one finding that could meaningfully reshape Task 4's atcute-hook wiring.
