# XRPC Plan 04 — Provider Implementation Plan (STUB)

> **Status: STUB / not yet drafted.** This file holds Plan 04 scope notes and one fully-drafted task (Shutdown) that was carved out during the Plan 03 review. The remaining tasks listed under "Scope" still need to be brainstormed and written up before execution — do NOT dispatch this plan to an executing subagent yet.

> **For agentic workers (once fully drafted):** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand Plan 03's minimal provider into the full `XrpcProvider` + `XrpcService` facade: error-handler registration (regular + subscription), `HttpContext.xrpc` Macroable getter, atcute's `handleException` / `handleSubscriptionException` wiring, and a `shutdown()` hook that drains in-flight WebSocket subscriptions cleanly. After this plan, consumers have the full `xrpc.errorHandler(() => import('#exceptions/handler'))` registration shape from `start/kernel.ts`, the `ctx.xrpc.auth` extension point ready for Plan 05, and graceful WS teardown on SIGTERM / dev-reload.

**Spec reference:** `docs/specs/2026-05-21-adonisjs-atproto-xrpc-design.md` §§ _XrpcService facade_, _Lifecycle phases_, _Error reporting (procedure/query and subscription)_.

**Depends on:** Plan 03 (dispatch) — `XrpcServer`, `XrpcDispatchMiddleware`, executor seams, minimal `XrpcProvider` from Task 7b. Plan 04 expands the provider; it does not replace it.

---

## Scope (drafting checklist — fill in as tasks before executing)

Carried forward from Plan 03 Task 7b's "What Plan 04 will add" list, plus Shutdown carved out during the Plan 03 review on 2026-05-25.

- [ ] **Task A: `XrpcService` facade** — `errorHandler(factory)` and `subscriptionErrorHandler(factory)` registration API. Late-bound factory pattern (see spec § _XrpcService — error handler registration_). Container singleton bound at `boot()` so `start/kernel.ts` can register handlers before any request fires.
- [ ] **Task B: `XrpcService` services module** — `services/xrpc.ts` (singleton accessor pattern, like `@adonisjs/core/services/server`) so consumers `import xrpc from '@thisismissem/adonisjs-atproto-xrpc/service'` and register handlers without dipping into the container.
- [ ] **Task C: `HttpContext.xrpc` Macroable getter** — provider's `register()` phase installs the macro. Returns the active `XrpcContext` (read via `XrpcContext.getOrFail()`) when in an XRPC dispatch scope; throws otherwise. Lets consumers reach `ctx.xrpc.auth`, `ctx.xrpc.lexicon`, etc. from regular Adonis middleware that runs around XRPC handlers.
- [ ] **Task D: Atcute exception hooks** — widen `XRPCRouter` construction in the provider's `ready()` to pass `handleException` and `handleSubscriptionException`. Each calls `xrpcService.getRegisteredErrorHandler()?.report(err, httpCtx)` (or the subscription variant) before encoding the wire-format error.
- [ ] **Task E: Executor seam wiring** — fill in the `// ERROR-REPORTING SEAM (Plan 04)` comment-anchors in `createXrpcExecutor` (procedure/query branch) and `wrapSubscriptionIterator` (subscription branch). Both call into the resolved error handler before re-throwing.
- [ ] **Task F: `shutdown()` hook** — drafted below in this file. Pull into the eventual full Plan 04 structure with its own pre-flight, file list, and self-review entries.
- [ ] **Task G: Tests** — provider tests for each of A–F. Reuse `setupApp` + `rcFileContents.providers` shape from Plan 03 Task 7b. Functional test: register an error handler, throw from a procedure handler, assert `report()` was called with the right HttpContext.
- [ ] **Task H: Changeset entry** — minor bump (new public surface: `xrpc.errorHandler(...)`, `ctx.xrpc`, `XrpcService` service module).

---

## Task F: Provider `shutdown()` hook — graceful WS teardown

**Status: ready to execute** (drafted during Plan 03 review on 2026-05-25 — see the conversation transcript for the design rationale).

**Files:**

- Modify: `providers/provider.ts` — add `shutdown()` method
- Modify: `src/xrpc_server.ts` — add `XrpcServer.shutdown(graceMs?)` method that the provider delegates to
- Create: `tests/provider_shutdown.spec.ts` — exercises the close-frame send + grace period + force-terminate fallback

**Why this exists:** Adonis's graceful-shutdown machinery already drains in-flight HTTP requests, but WebSocket subscriptions sit outside that. Without an explicit `shutdown()`, on SIGTERM / dev-reload:

1. The HTTP server closes; in-flight HTTP requests get the grace window and finish.
2. WS connections don't receive a close frame. Clients hang until their next ping fails (typically 30s).
3. Subscription async-generator handlers keep running until the Node process is killed — DB connections held, transaction-log watchers still pulling, etc.
4. On rolling deploys behind a load balancer: reconnect storms when old clients all re-handshake to the new pod simultaneously after their ping timeouts.

The shutdown sequence: stop accepting new upgrades → send 1001 (Going Away) to all connected clients → wait briefly for graceful disconnects → force-terminate survivors.

**Concrete sketch** (to be tightened during execution against the actual atcute / `ws` APIs):

```ts
// providers/provider.ts
async shutdown() {
  if (this.app.getEnvironment() !== 'web') return
  const xrpcServer = await this.app.container.make(XrpcServer)
  await xrpcServer.shutdown()
}

// src/xrpc_server.ts
async shutdown(graceMs = 3000): Promise<void> {
  // 1. Stop accepting new upgrades. Two implementation options to evaluate:
  //    (a) flip a `#shuttingDown` flag the wrapping 'upgrade' listener
  //        checks first, OR
  //    (b) `removeListener('upgrade', this.#upgradeListener)` to detach
  //        the wrapper entirely. (a) is more conservative — leaves the
  //        listener in place but no-ops it; (b) is more permanent but
  //        means subsequent reconfigure couldn't re-enable without a
  //        full install pass.
  this.#shuttingDown = true

  // 2. Send 1001 'going away' to every connected client. The clients see
  //    the close frame and exit their read loops cleanly rather than
  //    waiting for ping timeout. `wss.clients` is the canonical iterable
  //    in `ws` for connected sockets.
  for (const client of this.#ws.wss.clients) {
    client.close(1001, 'server shutting down')
  }

  // 3. Trigger per-subscription abort signals so handler async generators
  //    exit their `for await` loops. Plan 03's executor already passes
  //    atcute's `signal` into XrpcContext — when the underlying WS closes,
  //    atcute should fire that signal. Verify against atcute's behavior;
  //    if it doesn't auto-fire on socket close, we may need our own
  //    AbortController-per-subscription tracked on XrpcServer.

  // 4. Wait for clients to ack the close, with a hard timeout.
  await waitForAllClientsClosed(this.#ws.wss, graceMs)

  // 5. Force-terminate any survivors (clients that ignored the close
  //    frame or whose handler generators are stuck in a non-cancelable
  //    operation). `.terminate()` is `ws`'s hard-close.
  for (const client of this.#ws.wss.clients) {
    client.terminate()
  }
}

async function waitForAllClientsClosed(
  wss: WebSocketServer,
  graceMs: number
): Promise<void> {
  if (wss.clients.size === 0) return
  return new Promise((resolve) => {
    const start = Date.now()
    const check = () => {
      if (wss.clients.size === 0) return resolve()
      if (Date.now() - start > graceMs) return resolve()
      setTimeout(check, 50)
    }
    check()
  })
}
```

**Open questions for the execution pass:**

1. **Does atcute auto-fire the per-subscription `AbortSignal` when the underlying socket closes?** If yes, step 3 is implicit (the close frame from step 2 triggers atcute's signal, which triggers our handler exit). If no, we need to track an `AbortController` per active subscription in `XrpcServer` and `abort()` each one in shutdown. Verify against `@atcute/xrpc-server`'s subscription dispatch source before finalizing.

2. **Should `graceMs` be configurable via `defineConfig({ shutdownGraceMs: 3000 })`?** Tentative: yes, but with a sensible default and no required setting. Mirrors Adonis's `shutdownTimeout` config pattern.

3. **Does `Server.gracefulShutdown` (Adonis's HTTP-side shutdown) coordinate with provider `shutdown()` ordering?** The provider's `shutdown()` should run BEFORE the Node HTTP server's `.close()` — otherwise the server closes the underlying TCP socket out from under our 1001 frames. Verify provider-shutdown ordering against `@adonisjs/core@7.x`'s `Application.terminate()` flow; if needed, leave a comment in the provider's shutdown() explaining the ordering dependency.

4. **Test strategy.** A subscription functional test that opens a connection, asserts the close frame on shutdown, asserts the handler generator's exit, and asserts force-terminate fires after the grace window for a misbehaving client. Reuse `injectXrpcSubscription` from Plan 03 Task 9 to drive the WS side; trigger `app.terminate()` (or call `xrpcServer.shutdown()` directly) to exercise the path.

**Steps (skeleton — flesh out during execution):**

- [ ] **Step 1: Add `#shuttingDown` field and `shutdown(graceMs?)` method to `XrpcServer`** (per sketch above; reconcile with atcute's signal behavior per open question 1)
- [ ] **Step 2: Wire the wrapping `'upgrade'` listener to no-op when `#shuttingDown` is true**
- [ ] **Step 3: Add `shutdown()` method to `XrpcProvider`** that delegates to `XrpcServer.shutdown()`
- [ ] **Step 4: Write `tests/provider_shutdown.spec.ts`** — open subscription, trigger shutdown, assert close frame + handler exit + grace-window behavior
- [ ] **Step 5: Run tests; commit**

---

## Drafting handoff (when ready to finish Plan 04)

Use the `concise-planning` skill or hand-draft against Plan 03's structure:

1. Re-order Tasks A–H into a sensible execution order (Service facade first, then provider integration, then shutdown last so it builds on the existing structure).
2. Each task gets its own "Files" / "Steps" / commit pattern, matching Plan 03's style.
3. Pre-flight checks: confirm Plans 01–03 are committed; confirm `@adonisjs/core/services/server`-style singleton pattern is the right model for `services/xrpc.ts` (verify against current `@adonisjs/core@7.x` source).
4. Self-review section: spec coverage, type consistency, forward-compat seams (Plan 05 will add `XrpcAuth`).
