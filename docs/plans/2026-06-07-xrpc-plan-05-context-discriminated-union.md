# XRPC Plan 05 — Context Discriminated-Union Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Model:** Claude Sonnet (current generation) — the design is fully settled in the spec; execution is mechanical refactoring with structural reshape. Opus is overkill.

**Goal:** Replace the single `XrpcContext<L>` class with a discriminated union: a non-generic `XrpcOperationContext` abstract base + `XrpcHttpContext<L>` (query + procedure) + `XrpcSubscriptionContext<L>`. The public `XrpcContext<L>` symbol becomes a type alias resolving to the concrete subclass.

**Architecture:** Three concrete files under a new `src/context/` directory (`operation.ts`, `http.ts`, `subscription.ts`), plus `helpers.ts` for type-guard predicates and `main.ts` as the entrypoint. A single shared `AsyncLocalStorage` lives on the base; subclass-typed `static get / getOrFail` accessors read it and narrow via `instanceof`, with optional `<T extends LexiconInput<L>>` generic for lexicon-typed access mirroring the router's registration signature. Existing callers (executor, provider, exception_handler, factory, index, tests) update their imports and replace the single class with the appropriate subclass or shared base.

**Tech Stack:** TypeScript (strict, ESM-only, Node 24+), `@poppinss/macroable`, Node `AsyncLocalStorage`, Japa test runner, pnpm. AdonisJS v7.

**Spec source of truth:** [`docs/specs/2026-06-07-xrpc-context-discriminated-union-design.md`](../specs/2026-06-07-xrpc-context-discriminated-union-design.md) — when the plan and spec disagree, the spec wins; raise the discrepancy.

---

## File structure

**New files:**

| Path | Responsibility |
|---|---|
| `src/context/operation.ts` | Non-generic abstract `XrpcOperationContext` base. Holds the shared ALS, the static `get / getOrFail` returning the base reference, and cross-cutting fields (`request`, `signal`, `logger`, `containerResolver`, `requestId`, abstract `type` discriminator). Extends `Macroable`. |
| `src/context/http.ts` | `XrpcHttpContext<L>` subclass for query + procedure. Adds `lexicon`, `params`, `input`, `response: XrpcResponse<L>`. Subclass `static get / getOrFail<T extends LexiconInput<...>>` accessors that `instanceof`-narrow on the shared base ALS. |
| `src/context/subscription.ts` | `XrpcSubscriptionContext<L>` subclass. Adds `lexicon`, `params`, `stream: XrpcStream<L>`. Mirror static accessors. |
| `src/context/helpers.ts` | Type-guard predicates `isHttpContext` / `isSubscriptionContext`. Generic over `Ctx extends XrpcOperationContext` so narrowing preserves the input's L. |
| `src/context/main.ts` | Re-exports all four files + the `XrpcContext<L>` public type alias. Entrypoint for callers (replaces `src/context.ts`). |
| `tests/context/operation.spec.ts` | Tests the abstract base's ALS, Macroable static, cross-cutting fields. |
| `tests/context/http.spec.ts` | Tests `XrpcHttpContext` instantiation, `.response` access, ALS narrowing, lexicon-typed accessor (`LexiconInput<L>` form), inherited base fields, Macroable extension, `XrpcResponse` chainable setters via `ctx.response`. |
| `tests/context/subscription.spec.ts` | Tests `XrpcSubscriptionContext` instantiation, `.stream` access, ALS narrowing, lexicon-typed accessor, `XrpcStream` `signal`/`aborted`/`message()` helpers via `ctx.stream`. |
| `tests/context/helpers.spec.ts` | Tests both predicates: narrowing on subclass instances, narrowing through generic `Ctx`, runtime `false` on wrong-kind. |

**Modified files:**

| Path | What changes |
|---|---|
| `src/executor.ts` | Import from `./context/main.js`. Branch on `route.lexicon.type === 'xrpc_subscription'` for subclass selection. Use `XrpcOperationContext.als.run(...)` (shared base ALS). `wrapSubscriptionIterator` parameter type → `XrpcSubscriptionContext`. `runConsumerHandler` parameter type → `XrpcOperationContext`. |
| `src/exception_handler.ts` | Type imports: `XrpcContext<XrpcLexicon>` → `XrpcOperationContext` on `report` / `handle` signatures. |
| `index.ts` | Re-export point switches from `./src/context.js` to `./src/context/main.js`. Re-export the new classes + helpers + type alias. |
| `providers/provider.ts` | Import switches to `../src/context/main.js`. `XrpcContext.get()` → `XrpcOperationContext.get()` at lines 208 and 255. |
| `factories/xrpc.ts` | `create()` becomes an overloaded method (3 signatures + implementation). Runtime branch on `lexicon.type`. |
| `tests/provider_error_reporting.spec.ts` | Type import update; `XrpcContext<XrpcLexicon> \| null` → `XrpcOperationContext \| null`. |
| `tests/xrpc_server.spec.ts` | `XrpcContext.als.getStore()` → `XrpcOperationContext.als.getStore()` (lines 288, 297). Import update. |
| `tests/factory.spec.ts` | Type ref update for factory return. |

**Deleted files:**

| Path | Reason |
|---|---|
| `src/context.ts` | Replaced entirely by `src/context/main.ts` + four sibling files. |
| `tests/context.spec.ts` | Replaced by the four-file `tests/context/` split. Existing `XrpcResponse` chainable-setter tests migrate into `tests/context/http.spec.ts`; existing `XrpcStream` helper tests migrate into `tests/context/subscription.spec.ts`. |

**Post-merge cleanup (not an executable task, surfaced for awareness):**

- Delete the `xrpc-context-response-narrowing` memory file at `~/.claude/projects/-Users-emelia-Development-git-github-com-thisismissem-adonisjs-atproto-xrpc/memory/xrpc-context-response-narrowing.md` and remove its line from `MEMORY.md` in the same directory. The note is superseded by this refactor.

---

## Notes on conventions

- **File extensions in imports:** This repo uses `.ts` import specifiers internally and relies on the build pipeline (`tsdown`) to rewrite to `.js`. The exception is `index.ts` and configure-related re-exports which use `.js` because they're the published surface. Follow the existing pattern in each file you modify — match what's already there.
- **Commit messages:** Conventional commits (`feat(scope):`, `refactor(scope):`, etc.). The scope `context` is appropriate for the new module; `executor`, `provider`, `factory` for those callers. Examples in this plan are illustrative — match the project's actual recent commit style if it differs.
- **No `--no-gpg-sign` exception for plan 05.** Plan 04's CLAUDE.md exception is scoped to plans 01–04. Plan 05 commits sign normally; Emelia will Touch ID each commit. If the signing prompts become a workflow blocker during execution, surface that to Emelia rather than silently bypassing.
- **Test runner:** `pnpm quick:test --files <glob>` runs a single file. `pnpm test` runs the full pipeline (lint + typecheck + tests).
- **Lint and typecheck:** `pnpm lint` (which itself runs `typecheck`) and `pnpm typecheck` standalone. `pretest` runs `pnpm lint` automatically so `pnpm test` is the safety net.

---

## Task 1: Scaffold `XrpcOperationContext` abstract base

**Files:**
- Create: `src/context/operation.ts`
- Create: `tests/context/operation.spec.ts`

The base class doesn't depend on the lexicon, so it's non-generic. Macroable extension lives here; both subclasses inherit `Macroable` through this class.

- [ ] **Step 1: Create `src/context/operation.ts`**

```ts
import { AsyncLocalStorage } from 'node:async_hooks'
import Macroable from '@poppinss/macroable'
import { RuntimeException } from '@adonisjs/core/exceptions'
import type { HttpRequest } from '@adonisjs/core/http'
import type { Logger } from '@adonisjs/core/logger'
import type { ContainerResolver } from '@adonisjs/core/container'

/**
 * Constructor parameters for the abstract base. Non-generic — only the
 * cross-cutting fields whose types don't depend on the lexicon.
 * Subclass params (XrpcHttpContextParams / XrpcSubscriptionContextParams)
 * extend this with lexicon, params, and kind-specific fields.
 */
export interface XrpcOperationContextParams {
  request: HttpRequest
  signal: AbortSignal
  logger: Logger
  containerResolver: ContainerResolver<any>
  requestId: string
}

/**
 * Abstract base for XRPC operation contexts. Non-generic: lexicon-typed
 * fields (lexicon, params, response/stream, input) live on the concrete
 * subclasses. The base holds only request-scoped cross-cutting state plus
 * the shared AsyncLocalStorage that the executor writes once per request.
 *
 * Subclass-typed accessors (XrpcHttpContext.getOrFail / XrpcSubscriptionContext.getOrFail)
 * read this same ALS and `instanceof`-narrow on read. The base's own
 * `getOrFail()` returns this non-generic reference, suitable for
 * context-agnostic infrastructure code (logger access, exception reporting).
 */
export abstract class XrpcOperationContext extends Macroable {
  static readonly als = new AsyncLocalStorage<XrpcOperationContext>()

  static get(): XrpcOperationContext | undefined {
    return XrpcOperationContext.als.getStore()
  }

  static getOrFail(): XrpcOperationContext {
    const ctx = XrpcOperationContext.als.getStore()
    if (!ctx) {
      throw new RuntimeException(
        'XrpcOperationContext is not available — called outside an XRPC handler scope'
      )
    }
    return ctx
  }

  abstract readonly type: 'query' | 'procedure' | 'subscription'

  readonly request: HttpRequest
  readonly signal: AbortSignal
  readonly logger: Logger
  readonly containerResolver: ContainerResolver<any>
  readonly requestId: string

  protected constructor(params: XrpcOperationContextParams) {
    super()
    this.request = params.request
    this.signal = params.signal
    this.logger = params.logger
    this.containerResolver = params.containerResolver
    this.requestId = params.requestId
  }
}
```

- [ ] **Step 2: Create `tests/context/operation.spec.ts`**

The abstract base can't be instantiated directly. The runtime tests for ALS get/getOrFail happen in the subclass specs (which can construct concrete instances). This spec covers the static surface that's testable without instantiation: ALS instance exists, `get()` returns undefined outside scope, `getOrFail()` throws outside scope, `Macroable` static `.macro` is exposed.

```ts
import { test } from '@japa/runner'
import { AsyncLocalStorage } from 'node:async_hooks'
import { XrpcOperationContext } from '../../src/context/operation.ts'

test.group('XrpcOperationContext — static surface', () => {
  test('exposes an AsyncLocalStorage instance', ({ assert }) => {
    assert.instanceOf(XrpcOperationContext.als, AsyncLocalStorage)
  })

  test('get() returns undefined outside any als.run scope', ({ assert }) => {
    assert.isUndefined(XrpcOperationContext.get())
  })

  test('getOrFail() throws outside any als.run scope', ({ assert }) => {
    assert.throws(
      () => XrpcOperationContext.getOrFail(),
      /XrpcOperationContext is not available/
    )
  })

  test('exposes static .macro from Macroable', ({ assert }) => {
    assert.isFunction((XrpcOperationContext as any).macro)
  })
})
```

- [ ] **Step 3: Run the new tests**

```bash
pnpm quick:test --files 'tests/context/operation.spec.ts'
```

Expected: 4 passing tests.

- [ ] **Step 4: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS (no errors). The new file is self-contained and doesn't yet affect any callers.

- [ ] **Step 5: Commit**

```bash
git add src/context/operation.ts tests/context/operation.spec.ts
git commit -m "feat(context): scaffold XrpcOperationContext abstract base"
```

---

## Task 2: Add `XrpcHttpContext` subclass

**Files:**
- Create: `src/context/http.ts`
- Create: `tests/context/http.spec.ts`

`XrpcHttpContext<L>` covers both query and procedure lexicons. The `type` field is assigned from `params.lexicon.type` at construction (`'xrpc_query'` → `'query'`, `'xrpc_procedure'` → `'procedure'`). The static accessors take a `T extends LexiconInput<...>` generic so callers can assert either the namespace form (`<typeof MyProc>`) or the bare schema form (`<typeof MyProc.mainSchema>`).

- [ ] **Step 1: Create `src/context/http.ts`**

```ts
import { RuntimeException } from '@adonisjs/core/exceptions'
import { XrpcOperationContext, type XrpcOperationContextParams } from './operation.ts'
import { XrpcResponse } from '../response.ts'
import type {
  InferInput,
  InferParams,
  LexiconInput,
  ResolveLexicon,
  XrpcProcedureLexicon,
  XrpcQueryLexicon,
} from '../types.ts'

/**
 * Constructor parameters for XrpcHttpContext. Extends the base params with
 * lexicon, params, and input — the L-parameterized fields that distinguish
 * an HTTP operation context from the abstract base.
 */
export interface XrpcHttpContextParams<L extends XrpcQueryLexicon | XrpcProcedureLexicon>
  extends XrpcOperationContextParams {
  lexicon: L
  params: InferParams<L>
  input: InferInput<L>
}

/**
 * Operation context for query + procedure routes. Carries `response`
 * (XrpcResponse<L> — the buffered response-state slot the executor reads
 * after the handler resolves), plus the lexicon-typed `lexicon`, `params`,
 * and `input` fields.
 *
 * The `type` discriminator narrows to 'query' | 'procedure' (assigned from
 * lexicon.type at construction); subscription contexts have `type ===
 * 'subscription'`.
 */
export class XrpcHttpContext<
  L extends XrpcQueryLexicon | XrpcProcedureLexicon = XrpcQueryLexicon | XrpcProcedureLexicon,
> extends XrpcOperationContext {
  /**
   * Read the current XRPC HTTP context from the shared ALS. Returns undefined
   * if there's no active scope OR if the active scope is a subscription
   * (instanceof check narrows to HTTP-kind).
   *
   * The T generic accepts either a bare lexicon schema or a namespace
   * wrapper (`LexiconInput<L>`) — same shape `router.xrpc.procedure / query`
   * take for registration. ResolveLexicon<T> unwraps the namespace form so
   * the returned context's lexicon-typed fields are precise.
   *
   * The T assertion is NOT runtime-verified against the actual scope's
   * lexicon — instanceof only verifies HTTP-kind. Caller-assertion semantics
   * apply (same trade-off as `as XrpcHttpContext<L>`).
   */
  static get<
    T extends LexiconInput<XrpcQueryLexicon | XrpcProcedureLexicon> =
      | XrpcQueryLexicon
      | XrpcProcedureLexicon,
  >(): XrpcHttpContext<ResolveLexicon<T>> | undefined {
    const ctx = XrpcOperationContext.als.getStore()
    return ctx instanceof XrpcHttpContext
      ? (ctx as XrpcHttpContext<ResolveLexicon<T>>)
      : undefined
  }

  static getOrFail<
    T extends LexiconInput<XrpcQueryLexicon | XrpcProcedureLexicon> =
      | XrpcQueryLexicon
      | XrpcProcedureLexicon,
  >(): XrpcHttpContext<ResolveLexicon<T>> {
    const ctx = XrpcHttpContext.get<T>()
    if (!ctx) {
      throw new RuntimeException(
        'XrpcHttpContext is not available — called outside an XRPC HTTP handler scope'
      )
    }
    return ctx
  }

  readonly type: 'query' | 'procedure'
  readonly lexicon: L
  readonly params: InferParams<L>
  readonly input: InferInput<L>
  readonly response: XrpcResponse<L>

  constructor(params: XrpcHttpContextParams<L>) {
    super(params)
    this.lexicon = params.lexicon
    this.params = params.params
    this.type = params.lexicon.type === 'xrpc_query' ? 'query' : 'procedure'
    this.input = params.input
    this.response = new XrpcResponse<L>()
  }
}
```

- [ ] **Step 2: Create `tests/context/http.spec.ts`**

This file absorbs the procedure-kind tests from the old `tests/context.spec.ts`, the ALS scope tests for HTTP context, and the `XrpcResponse` chainable-setter tests (which used to go through `ctx.response as XrpcResponse<any>` and now don't need the cast).

```ts
import { test } from '@japa/runner'
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import { XrpcOperationContext } from '../../src/context/operation.ts'
import { XrpcHttpContext } from '../../src/context/http.ts'
import { XrpcResponse } from '../../src/response.ts'

const queryLex = { nsid: 'com.example.test.query', type: 'xrpc_query' } as any
const procedureLex = { nsid: 'com.example.test.proc', type: 'xrpc_procedure' } as any

function makeHttpContext(overrides: { lexicon?: any; input?: any; params?: any } = {}) {
  const httpCtx = new HttpContextFactory().create()
  const lexicon = overrides.lexicon ?? procedureLex
  return new XrpcHttpContext({
    lexicon,
    request: httpCtx.request,
    input: overrides.input,
    params: overrides.params ?? {},
    signal: new AbortController().signal,
    logger: httpCtx.logger,
    containerResolver: httpCtx.containerResolver,
    requestId: httpCtx.request.id() ?? 'test-req-id',
  })
}

test.group('XrpcHttpContext — construction', () => {
  test('exposes the materialized base primitives directly', ({ assert }) => {
    const ctx = makeHttpContext()
    assert.isObject(ctx.logger)
    assert.isObject(ctx.containerResolver)
    assert.isString(ctx.requestId)
    assert.isObject(ctx.request)
  })

  test('procedure-kind lexicon sets type to "procedure"', ({ assert }) => {
    const ctx = makeHttpContext({ lexicon: procedureLex })
    assert.equal(ctx.type, 'procedure')
  })

  test('query-kind lexicon sets type to "query"', ({ assert }) => {
    const ctx = makeHttpContext({ lexicon: queryLex })
    assert.equal(ctx.type, 'query')
  })

  test('exposes response as XrpcResponse instance', ({ assert }) => {
    const ctx = makeHttpContext()
    assert.instanceOf(ctx.response, XrpcResponse)
  })

  test('is an instance of XrpcOperationContext (inheritance)', ({ assert }) => {
    const ctx = makeHttpContext()
    assert.instanceOf(ctx, XrpcOperationContext)
  })
})

test.group('XrpcHttpContext.get / .getOrFail — ALS', () => {
  test('get() returns undefined outside any als.run scope', ({ assert }) => {
    assert.isUndefined(XrpcHttpContext.get())
  })

  test('getOrFail() throws outside any als.run scope', ({ assert }) => {
    assert.throws(() => XrpcHttpContext.getOrFail(), /XrpcHttpContext is not available/)
  })

  test('both return the active HTTP context inside an als.run scope', async ({ assert }) => {
    const ctx = makeHttpContext()
    await XrpcOperationContext.als.run(ctx, async () => {
      assert.equal(XrpcHttpContext.get(), ctx)
      assert.equal(XrpcHttpContext.getOrFail(), ctx)
      await new Promise((r) => setImmediate(r))
      assert.equal(XrpcHttpContext.get(), ctx)
      assert.equal(XrpcHttpContext.getOrFail(), ctx)
    })
  })

  test('nested scopes shadow the outer context', async ({ assert }) => {
    const outer = makeHttpContext()
    const inner = makeHttpContext()
    await XrpcOperationContext.als.run(outer, async () => {
      assert.equal(XrpcHttpContext.getOrFail(), outer)
      await XrpcOperationContext.als.run(inner, async () => {
        assert.equal(XrpcHttpContext.getOrFail(), inner)
      })
      assert.equal(XrpcHttpContext.getOrFail(), outer)
    })
  })

  test('XrpcOperationContext.als also returns the HTTP context (shared storage)', async ({
    assert,
  }) => {
    const ctx = makeHttpContext()
    await XrpcOperationContext.als.run(ctx, async () => {
      assert.equal(XrpcOperationContext.getOrFail(), ctx)
    })
  })
})

test.group('XrpcHttpContext — response state', () => {
  test('status / header mutate internal state and return this', ({ assert }) => {
    const ctx = makeHttpContext()
    const ret = ctx.response.status(201).header('etag', 'abc')
    assert.equal(ret, ctx.response, 'chain returns itself')
    assert.equal(ctx.response.state.status, 201)
    assert.equal(ctx.response.state.headers.get('etag'), 'abc')
  })

  test('json() buffers the body and flips bodySet', ({ assert }) => {
    const ctx = makeHttpContext()
    ctx.response.json({ id: 'x' } as any)
    assert.deepEqual(ctx.response.state.body, { id: 'x' })
    assert.isTrue(ctx.response.state.bodySet)
  })

  test('bodySet defaults to false when json() is never called', ({ assert }) => {
    const ctx = makeHttpContext()
    ctx.response.status(204)
    assert.isFalse(ctx.response.state.bodySet)
    assert.isUndefined(ctx.response.state.body)
  })

  test('initial state has empty Headers and undefined status / body / redirect', ({ assert }) => {
    const ctx = makeHttpContext()
    const state = ctx.response.state
    assert.isUndefined(state.status)
    assert.isUndefined(state.body)
    assert.isUndefined(state.redirect)
    assert.isFalse(state.bodySet)
    assert.instanceOf(state.headers, Headers)
    assert.equal([...state.headers].length, 0)
  })

  test('redirect() records url + status on state', ({ assert }) => {
    const ctx = makeHttpContext()
    ctx.response.redirect('https://cdn.example/blob.bin', 302)
    assert.deepEqual(ctx.response.state.redirect, {
      url: 'https://cdn.example/blob.bin',
      status: 302,
    })
  })
})

test.group('XrpcHttpContext — Macroable', () => {
  test('exposes static .macro inherited from Macroable', ({ assert }) => {
    assert.isFunction((XrpcHttpContext as any).macro)
  })
})
```

- [ ] **Step 3: Run the new tests**

```bash
pnpm quick:test --files 'tests/context/http.spec.ts'
```

Expected: all tests pass.

- [ ] **Step 4: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context/http.ts tests/context/http.spec.ts
git commit -m "feat(context): add XrpcHttpContext subclass for query + procedure"
```

---

## Task 3: Add `XrpcSubscriptionContext` subclass

**Files:**
- Create: `src/context/subscription.ts`
- Create: `tests/context/subscription.spec.ts`

Mirror of Task 2 for the subscription kind. `XrpcStream<L>` is constructed inside the subclass constructor from the lexicon + signal already on the base params; no separate `stream` param needed.

- [ ] **Step 1: Create `src/context/subscription.ts`**

```ts
import { RuntimeException } from '@adonisjs/core/exceptions'
import { XrpcOperationContext, type XrpcOperationContextParams } from './operation.ts'
import { XrpcStream } from '../stream.ts'
import type {
  InferParams,
  LexiconInput,
  ResolveLexicon,
  XrpcSubscriptionLexicon,
} from '../types.ts'

/**
 * Constructor parameters for XrpcSubscriptionContext. Extends the base
 * params with lexicon and params; XrpcStream is constructed from the
 * lexicon + signal inside the subclass constructor.
 */
export interface XrpcSubscriptionContextParams<L extends XrpcSubscriptionLexicon>
  extends XrpcOperationContextParams {
  lexicon: L
  params: InferParams<L>
}

/**
 * Operation context for subscription routes. Carries `stream`
 * (XrpcStream<L> — the message builder + signal-mirror used by async
 * generators), plus the lexicon-typed `lexicon` and `params`.
 *
 * The `type` discriminator is the literal 'subscription'.
 */
export class XrpcSubscriptionContext<
  L extends XrpcSubscriptionLexicon = XrpcSubscriptionLexicon,
> extends XrpcOperationContext {
  /**
   * Read the current XRPC subscription context from the shared ALS. Returns
   * undefined if no active scope or if the active scope is HTTP.
   *
   * The T generic accepts either a bare lexicon schema or a namespace
   * wrapper (`LexiconInput<L>`) — same shape `router.xrpc.subscription`
   * takes for registration. Caller-assertion semantics for L (same trade-
   * off as XrpcHttpContext.get / getOrFail — see those docstrings).
   */
  static get<
    T extends LexiconInput<XrpcSubscriptionLexicon> = XrpcSubscriptionLexicon,
  >(): XrpcSubscriptionContext<ResolveLexicon<T>> | undefined {
    const ctx = XrpcOperationContext.als.getStore()
    return ctx instanceof XrpcSubscriptionContext
      ? (ctx as XrpcSubscriptionContext<ResolveLexicon<T>>)
      : undefined
  }

  static getOrFail<
    T extends LexiconInput<XrpcSubscriptionLexicon> = XrpcSubscriptionLexicon,
  >(): XrpcSubscriptionContext<ResolveLexicon<T>> {
    const ctx = XrpcSubscriptionContext.get<T>()
    if (!ctx) {
      throw new RuntimeException(
        'XrpcSubscriptionContext is not available — called outside an XRPC subscription handler scope'
      )
    }
    return ctx
  }

  readonly type = 'subscription' as const
  readonly lexicon: L
  readonly params: InferParams<L>
  readonly stream: XrpcStream<L>

  constructor(params: XrpcSubscriptionContextParams<L>) {
    super(params)
    this.lexicon = params.lexicon
    this.params = params.params
    this.stream = new XrpcStream<L>(params.lexicon, params.signal)
  }
}
```

- [ ] **Step 2: Create `tests/context/subscription.spec.ts`**

```ts
import { test } from '@japa/runner'
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import { XrpcOperationContext } from '../../src/context/operation.ts'
import { XrpcSubscriptionContext } from '../../src/context/subscription.ts'
import { XrpcStream } from '../../src/stream.ts'

const subscriptionLex = { nsid: 'com.example.test.sub', type: 'xrpc_subscription' } as any

function makeSubscriptionContext(overrides: { lexicon?: any; params?: any; signal?: AbortSignal } = {}) {
  const httpCtx = new HttpContextFactory().create()
  const lexicon = overrides.lexicon ?? subscriptionLex
  return new XrpcSubscriptionContext({
    lexicon,
    request: httpCtx.request,
    params: overrides.params ?? {},
    signal: overrides.signal ?? new AbortController().signal,
    logger: httpCtx.logger,
    containerResolver: httpCtx.containerResolver,
    requestId: httpCtx.request.id() ?? 'test-req-id',
  })
}

test.group('XrpcSubscriptionContext — construction', () => {
  test('exposes the materialized base primitives directly', ({ assert }) => {
    const ctx = makeSubscriptionContext()
    assert.isObject(ctx.logger)
    assert.isObject(ctx.containerResolver)
    assert.isString(ctx.requestId)
    assert.isObject(ctx.request)
  })

  test('type is the literal "subscription"', ({ assert }) => {
    const ctx = makeSubscriptionContext()
    assert.equal(ctx.type, 'subscription')
  })

  test('exposes stream as XrpcStream instance', ({ assert }) => {
    const ctx = makeSubscriptionContext()
    assert.instanceOf(ctx.stream, XrpcStream)
  })

  test('is an instance of XrpcOperationContext (inheritance)', ({ assert }) => {
    const ctx = makeSubscriptionContext()
    assert.instanceOf(ctx, XrpcOperationContext)
  })
})

test.group('XrpcSubscriptionContext.get / .getOrFail — ALS', () => {
  test('get() returns undefined outside any als.run scope', ({ assert }) => {
    assert.isUndefined(XrpcSubscriptionContext.get())
  })

  test('getOrFail() throws outside any als.run scope', ({ assert }) => {
    assert.throws(
      () => XrpcSubscriptionContext.getOrFail(),
      /XrpcSubscriptionContext is not available/
    )
  })

  test('both return the active subscription context inside an als.run scope', async ({
    assert,
  }) => {
    const ctx = makeSubscriptionContext()
    await XrpcOperationContext.als.run(ctx, async () => {
      assert.equal(XrpcSubscriptionContext.get(), ctx)
      assert.equal(XrpcSubscriptionContext.getOrFail(), ctx)
      await new Promise((r) => setImmediate(r))
      assert.equal(XrpcSubscriptionContext.get(), ctx)
      assert.equal(XrpcSubscriptionContext.getOrFail(), ctx)
    })
  })
})

test.group('XrpcSubscriptionContext — stream helpers', () => {
  test('stream.signal / aborted mirror the AbortController', ({ assert }) => {
    const ac = new AbortController()
    const ctx = makeSubscriptionContext({ signal: ac.signal })
    assert.equal(ctx.stream.signal, ac.signal)
    assert.isFalse(ctx.stream.aborted)
    ac.abort()
    assert.isTrue(ctx.stream.aborted)
  })

  test('stream.message() returns a payload with $type derived from NSID + ref', ({
    assert,
  }) => {
    const ctx = makeSubscriptionContext()
    const msg = (ctx.stream as any).message('#labels', { seq: 1 })
    assert.deepEqual(msg, { $type: 'com.example.test.sub#labels', seq: 1 })
  })
})

test.group('XrpcSubscriptionContext — Macroable', () => {
  test('exposes static .macro inherited from Macroable', ({ assert }) => {
    assert.isFunction((XrpcSubscriptionContext as any).macro)
  })
})
```

- [ ] **Step 3: Run the new tests**

```bash
pnpm quick:test --files 'tests/context/subscription.spec.ts'
```

Expected: all tests pass.

- [ ] **Step 4: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context/subscription.ts tests/context/subscription.spec.ts
git commit -m "feat(context): add XrpcSubscriptionContext subclass"
```

---

## Task 4: Add predicate helpers + `main.ts` re-exports + `XrpcContext<L>` type alias

**Files:**
- Create: `src/context/helpers.ts`
- Create: `src/context/main.ts`
- Create: `tests/context/helpers.spec.ts`

`helpers.ts` exports two type-guard predicates generic over `Ctx extends XrpcOperationContext` so the intersection `Ctx & XrpcHttpContext` preserves any L the input already had refined.

`main.ts` is the public surface: re-exports + the `XrpcContext<L>` type alias that resolves to the concrete subclass based on the lexicon kind.

- [ ] **Step 1: Create `src/context/helpers.ts`**

```ts
import { XrpcHttpContext } from './http.ts'
import { XrpcSubscriptionContext } from './subscription.ts'
import type { XrpcOperationContext } from './operation.ts'

/**
 * Narrows a context reference to `XrpcHttpContext`. Useful when consumer
 * code holds an `XrpcOperationContext` (or the wide `XrpcContext<XrpcLexicon>`
 * union) and needs to read `.response` / `.input` / lexicon-typed fields.
 *
 * Generic over `Ctx` so the narrowing preserves whatever refinement the
 * caller already had — `Ctx & XrpcHttpContext` keeps the inferred lexicon
 * parameter on the narrowed result instead of collapsing to the default-L
 * `XrpcHttpContext`.
 */
export function isHttpContext<Ctx extends XrpcOperationContext>(
  ctx: Ctx
): ctx is Ctx & XrpcHttpContext {
  return ctx instanceof XrpcHttpContext
}

/**
 * Narrows a context reference to `XrpcSubscriptionContext`. Symmetric to
 * `isHttpContext` — for code that needs to read `.stream` or
 * subscription-lexicon-typed fields. Also generic over `Ctx` to preserve L.
 */
export function isSubscriptionContext<Ctx extends XrpcOperationContext>(
  ctx: Ctx
): ctx is Ctx & XrpcSubscriptionContext {
  return ctx instanceof XrpcSubscriptionContext
}
```

- [ ] **Step 2: Create `src/context/main.ts`**

```ts
import type {
  XrpcLexicon,
  XrpcProcedureLexicon,
  XrpcQueryLexicon,
  XrpcSubscriptionLexicon,
} from '../types.ts'
import type { XrpcHttpContext } from './http.ts'
import type { XrpcSubscriptionContext } from './subscription.ts'

export { XrpcOperationContext, type XrpcOperationContextParams } from './operation.ts'
export { XrpcHttpContext, type XrpcHttpContextParams } from './http.ts'
export {
  XrpcSubscriptionContext,
  type XrpcSubscriptionContextParams,
} from './subscription.ts'
export { isHttpContext, isSubscriptionContext } from './helpers.ts'

/**
 * Public union-alias surface — what handler authors annotate with.
 *
 * TypeScript reduces conditional type aliases eagerly when L is a
 * concrete type, so `XrpcContext<typeof myProcedureLex>` resolves directly
 * to `XrpcHttpContext<...>` at the handler site — `.response` is directly
 * accessible without narrowing.
 *
 * For wide L (e.g. `XrpcContext<XrpcLexicon>`), the conditional distributes
 * over the lexicon union, yielding the full discriminated union
 * (`XrpcHttpContext<XrpcQueryLexicon> | XrpcHttpContext<XrpcProcedureLexicon>
 * | XrpcSubscriptionContext<XrpcSubscriptionLexicon>`). Use this form in
 * signatures that accept any kind of context; narrow via `isHttpContext` /
 * `isSubscriptionContext` from `./helpers.ts`.
 */
export type XrpcContext<L extends XrpcLexicon> = L extends XrpcSubscriptionLexicon
  ? XrpcSubscriptionContext<L>
  : L extends XrpcQueryLexicon | XrpcProcedureLexicon
    ? XrpcHttpContext<L>
    : never
```

- [ ] **Step 3: Create `tests/context/helpers.spec.ts`**

```ts
import { test } from '@japa/runner'
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import { XrpcHttpContext } from '../../src/context/http.ts'
import { XrpcSubscriptionContext } from '../../src/context/subscription.ts'
import { isHttpContext, isSubscriptionContext } from '../../src/context/helpers.ts'

const procedureLex = { nsid: 'com.example.test.proc', type: 'xrpc_procedure' } as any
const subscriptionLex = { nsid: 'com.example.test.sub', type: 'xrpc_subscription' } as any

function baseParams() {
  const httpCtx = new HttpContextFactory().create()
  return {
    request: httpCtx.request,
    signal: new AbortController().signal,
    logger: httpCtx.logger,
    containerResolver: httpCtx.containerResolver,
    requestId: httpCtx.request.id() ?? 'test-req-id',
  }
}

test.group('isHttpContext', () => {
  test('returns true for XrpcHttpContext instances', ({ assert }) => {
    const ctx = new XrpcHttpContext({
      ...baseParams(),
      lexicon: procedureLex,
      params: {},
      input: undefined,
    })
    assert.isTrue(isHttpContext(ctx))
  })

  test('returns false for XrpcSubscriptionContext instances', ({ assert }) => {
    const ctx = new XrpcSubscriptionContext({
      ...baseParams(),
      lexicon: subscriptionLex,
      params: {},
    })
    assert.isFalse(isHttpContext(ctx))
  })

  test('narrows for downstream type-aware reads', ({ assert }) => {
    const ctx = new XrpcHttpContext({
      ...baseParams(),
      lexicon: procedureLex,
      params: {},
      input: undefined,
    })
    if (isHttpContext(ctx)) {
      // If this typechecks, narrowing works. The runtime access asserts
      // the field actually exists on the narrowed branch.
      assert.exists(ctx.response)
    }
  })
})

test.group('isSubscriptionContext', () => {
  test('returns true for XrpcSubscriptionContext instances', ({ assert }) => {
    const ctx = new XrpcSubscriptionContext({
      ...baseParams(),
      lexicon: subscriptionLex,
      params: {},
    })
    assert.isTrue(isSubscriptionContext(ctx))
  })

  test('returns false for XrpcHttpContext instances', ({ assert }) => {
    const ctx = new XrpcHttpContext({
      ...baseParams(),
      lexicon: procedureLex,
      params: {},
      input: undefined,
    })
    assert.isFalse(isSubscriptionContext(ctx))
  })

  test('narrows for downstream type-aware reads', ({ assert }) => {
    const ctx = new XrpcSubscriptionContext({
      ...baseParams(),
      lexicon: subscriptionLex,
      params: {},
    })
    if (isSubscriptionContext(ctx)) {
      assert.exists(ctx.stream)
    }
  })
})
```

- [ ] **Step 4: Run the new tests**

```bash
pnpm quick:test --files 'tests/context/helpers.spec.ts'
```

Expected: all tests pass.

- [ ] **Step 5: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/context/helpers.ts src/context/main.ts tests/context/helpers.spec.ts
git commit -m "feat(context): add predicate helpers + main.ts public surface"
```

---

## Task 5: Update executor to construct new subclasses

**Files:**
- Modify: `src/executor.ts`

The executor's existing branch on `route.lexicon.type === 'xrpc_subscription'` now also chooses the subclass. Both branches use the shared `XrpcOperationContext.als` — same storage, different class identity. The internal helpers (`wrapSubscriptionIterator`, `runConsumerHandler`) update their parameter types to match.

- [ ] **Step 1: Update `src/executor.ts`**

Replace the existing file with the version below. The diff from current state:

- Import `XrpcContext` → `XrpcOperationContext` + `XrpcHttpContext` + `XrpcSubscriptionContext` from `./context/main.ts`.
- The HTTP branch (which used to construct `new XrpcContext({...})` with `input: 'input' in atcuteCtx ? atcuteCtx.input : undefined`) now constructs `new XrpcHttpContext({...})` — same field list minus the `input ? atcuteCtx.input : undefined` ternary (XrpcHttpContext's constructor accepts that directly).
- The subscription branch constructs `new XrpcSubscriptionContext({...})` — no `input` field.
- `XrpcContext.als.run(...)` → `XrpcOperationContext.als.run(...)` in both branches.
- `wrapSubscriptionIterator(...)` parameter type: `XrpcContext<XrpcLexicon>` → `XrpcSubscriptionContext`.
- Inside `wrapSubscriptionIterator`, the per-`.next()` ALS re-entry: `XrpcContext.als.run(...)` → `XrpcOperationContext.als.run(...)`.
- `runConsumerHandler(...)` parameter type: `XrpcContext<XrpcLexicon>` → `XrpcOperationContext`.

```ts
import { XRPCSubscriptionError } from '@atcute/xrpc-server'
import {
  XrpcHttpContext,
  XrpcOperationContext,
  XrpcSubscriptionContext,
} from './context/main.ts'
import { InternalServerError, NotFoundError, XrpcError } from './errors.ts'
import { type RouteInfo } from './router/types.ts'
import { type XrpcSerializer } from './serializer.ts'
import { type XrpcService, REPORTED } from './xrpc_service.ts'
import { type RequestContext } from './request_context.ts'
import type {
  XrpcLexicon,
  XrpcProcedureLexicon,
  XrpcQueryLexicon,
} from './types.ts'

export type SharedXrpcExecutor = (
  atcuteCtx: any,
  requestCtx?: RequestContext
) => Promise<Response> | AsyncIterable<unknown>

export function createXrpcExecutor(deps: {
  operations: ReadonlyMap<string, RouteInfo>
  serializer: XrpcSerializer
  xrpc: XrpcService
}): SharedXrpcExecutor {
  const { operations, serializer, xrpc } = deps

  // NOTE: this is intentionally a non-async function. Subscription routes
  // need to return an `AsyncIterable<unknown>` *directly* — atcute's
  // `for await (const message of handler(context))` doesn't unwrap a Promise.
  // HTTP routes return `Promise<Response>` from `XrpcOperationContext.als.run(...)`.
  return (atcuteCtx, requestCtx) => {
    if (!requestCtx) {
      throw new InternalServerError(
        'XRPC executor invoked without a RequestContext — the dispatch boundary failed to populate requestContextStore'
      )
    }

    const nsid = new URL(atcuteCtx.request.url).pathname.slice('/xrpc/'.length)
    const route = operations.get(nsid)
    if (!route) {
      throw new NotFoundError(`No XRPC method registered for NSID '${nsid}'`)
    }

    const invokeHandler = (ctx: XrpcOperationContext): unknown =>
      route.handler.kind === 'function'
        ? route.handler.fn(ctx)
        : route.handler.handle(ctx.containerResolver, ctx)

    if (route.lexicon.type === 'xrpc_subscription') {
      const xrpcCtx = new XrpcSubscriptionContext({
        requestId: requestCtx.requestId,
        request: requestCtx.request,
        logger: requestCtx.logger,
        containerResolver: requestCtx.containerResolver,
        lexicon: route.lexicon,
        params: atcuteCtx.params,
        signal: atcuteCtx.signal,
      })
      // The handler() invocation that returns the AsyncIterable runs inside
      // the ALS scope — the handler may construct its iterator from service
      // calls that themselves read XrpcOperationContext.
      const userIterable = XrpcOperationContext.als.run(
        xrpcCtx,
        () => invokeHandler(xrpcCtx) as AsyncIterable<unknown>
      )
      return wrapSubscriptionIterator(userIterable, xrpcCtx, xrpc, serializer)
    }

    const xrpcCtx = new XrpcHttpContext({
      requestId: requestCtx.requestId,
      request: requestCtx.request,
      logger: requestCtx.logger,
      containerResolver: requestCtx.containerResolver,
      lexicon: route.lexicon as XrpcQueryLexicon | XrpcProcedureLexicon,
      input: 'input' in atcuteCtx ? atcuteCtx.input : undefined,
      params: atcuteCtx.params,
      signal: atcuteCtx.signal,
    })

    return XrpcOperationContext.als.run(xrpcCtx, async () => {
      try {
        const result = await invokeHandler(xrpcCtx)

        const respState = xrpcCtx.response.state

        if (respState.redirect) {
          return Response.redirect(respState.redirect.url, respState.redirect.status)
        }

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
        throw await runConsumerHandler(xrpc, err, xrpcCtx)
      }
    })
  }
}

/**
 * Run the consumer's registered ExceptionHandler against an error. Used
 * by both the procedure/query executor catch and the subscription wrapper
 * catch — single source of truth for the report → handle → mark sequence.
 *
 * Param type is XrpcOperationContext (non-generic) because this function
 * only reads shared fields (logger via xrpcCtx) — works for HTTP or
 * subscription scope.
 */
async function runConsumerHandler(
  xrpc: XrpcService,
  err: unknown,
  xrpcCtx: XrpcOperationContext
): Promise<XrpcError> {
  const handler = await xrpc.getRegisteredErrorHandler()

  if (handler) {
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

    const sanitized = await handler.handle(err, xrpcCtx)
    ;(sanitized as any)[REPORTED] = true
    return sanitized
  }

  const fallback =
    err instanceof XrpcError
      ? err
      : new InternalServerError(err instanceof Error ? err.message : String(err), { cause: err })
  ;(fallback as any)[REPORTED] = true
  return fallback
}

/**
 * Wraps a user-provided async-generator subscription handler with a
 * transforming generator that re-enters the XrpcOperationContext.als scope
 * on every inner `.next()` call and pipes yielded values through the
 * serializer. On error, XrpcError instances are translated to
 * XRPCSubscriptionError so atcute's handleSubscriptionException hook emits
 * the error frame.
 */
async function* wrapSubscriptionIterator(
  iterable: AsyncIterable<unknown>,
  xrpcCtx: XrpcSubscriptionContext,
  xrpc: XrpcService,
  serializer: XrpcSerializer
): AsyncGenerator<unknown> {
  const inner = iterable[Symbol.asyncIterator]()
  try {
    while (true) {
      const result = await XrpcOperationContext.als.run(xrpcCtx, () => inner.next())
      if (result.done) return
      yield await serializer.serializeWithoutWrapping(result.value, xrpcCtx.containerResolver)
    }
  } catch (err: any) {
    const xrpcError = await runConsumerHandler(xrpc, err, xrpcCtx)

    throw new XRPCSubscriptionError({
      error: xrpcError.errorName,
      message: xrpcError.message,
    })
  }
}
```

- [ ] **Step 2: Run the full test suite (lint + typecheck + tests)**

```bash
pnpm test
```

Expected: PASS. The executor is now using the new classes; existing tests of dispatch behaviour (`tests/dispatch.spec.ts`, `tests/dispatch_subscription.spec.ts`, `tests/xrpc_server.spec.ts`) still pass because the runtime behaviour is unchanged. The OLD `src/context.ts` is still present and exports the OLD `XrpcContext` class — `tests/context.spec.ts` continues to pass against it until Task 8 removes the file. The old class is now orphaned (no production code imports it) but harmless.

- [ ] **Step 3: Commit**

```bash
git add src/executor.ts
git commit -m "refactor(executor): construct XrpcHttpContext / XrpcSubscriptionContext per kind"
```

---

## Task 6: Update provider + exception_handler + index re-exports

**Files:**
- Modify: `providers/provider.ts`
- Modify: `src/exception_handler.ts`
- Modify: `index.ts`

The provider's two `XrpcContext.get() ?? null` calls (lines 208 and 255 in the current file) become `XrpcOperationContext.get() ?? null`. The exception handler's `report` / `handle` parameter types switch from `XrpcContext<XrpcLexicon> | null` to `XrpcOperationContext | null`. The package's `index.ts` re-export point updates to the new module.

- [ ] **Step 1: Update `providers/provider.ts`**

Change the import (line 11) from:

```ts
import { XrpcContext } from '../src/context.js'
```

to:

```ts
import { XrpcOperationContext } from '../src/context/main.js'
```

Then in the file body, replace **all** occurrences of `XrpcContext.get()` with `XrpcOperationContext.get()`. As of the current state these are at:

- Line 208 (inside `makeAtcuteHttpHook`)
- Line 255 (inside `makeSocketErrorObserver`)

The surrounding docstring on `makeAtcuteHttpHook` (around lines 181–184) mentions "**XrpcContext.get()** returns the active context…". Update that prose reference to `XrpcOperationContext.get()` as well, for consistency.

- [ ] **Step 2: Update `src/exception_handler.ts`**

Replace the imports (lines 1–5) from:

```ts
import type { ApplicationService } from '@adonisjs/core/types'

import { XrpcError, InternalServerError } from './errors.js'
import type { XrpcContext } from './context.js'
import type { XrpcLexicon } from './types.js'
```

with:

```ts
import type { ApplicationService } from '@adonisjs/core/types'

import { XrpcError, InternalServerError } from './errors.js'
import type { XrpcOperationContext } from './context/main.js'
```

Then update the `report` and `handle` signatures to drop the `<XrpcLexicon>` generic. The full updated method signatures inside `ExceptionHandler`:

```ts
  async report(_error: unknown, _ctx: XrpcOperationContext | null): Promise<void> {
    // No-op by default.
  }

  async handle(error: unknown, _ctx: XrpcOperationContext | null): Promise<XrpcError> {
    if (error instanceof XrpcError) return error
    if (this.app.inProduction) {
      return new InternalServerError('Internal Server Error')
    }
    return new InternalServerError(error instanceof Error ? error.message : String(error), {
      cause: error,
    })
  }
```

The docstring above `report` mentions "ctx is null for atcute-internal errors raised before the dispatch executor materializes an XrpcContext (request parsing failures, etc.) — guard with ctx?.lexicon.nsid etc." — that guidance is now subtly wrong because `XrpcOperationContext` doesn't carry `lexicon` (it's on the subclasses). Update to:

```ts
   * ctx is null for atcute-internal errors raised before the dispatch
   * executor materializes an XrpcOperationContext (request parsing
   * failures, etc.). When non-null, ctx is the base reference — narrow with
   * isHttpContext / isSubscriptionContext from
   * `@thisismissem/adonisjs-atproto-xrpc/src/context/main` for
   * lexicon-typed reads (.lexicon, .params, .input, .stream, .response).
```

- [ ] **Step 3: Update `index.ts`**

Replace the existing context re-export (line 15) from:

```ts
export { XrpcContext } from './src/context.js'
```

with:

```ts
export {
  XrpcOperationContext,
  XrpcHttpContext,
  XrpcSubscriptionContext,
  isHttpContext,
  isSubscriptionContext,
  type XrpcContext,
  type XrpcOperationContextParams,
  type XrpcHttpContextParams,
  type XrpcSubscriptionContextParams,
} from './src/context/main.js'
```

Update `tsdown.entry` in `package.json` — it lists each file individually (mirroring the `src/router/` entries) and currently includes `./src/context.ts`. Replace that single entry with the five new files in the same alphabetical / topical position:

Before:
```json
"./src/context.ts",
```

After:
```json
"./src/context/operation.ts",
"./src/context/http.ts",
"./src/context/subscription.ts",
"./src/context/helpers.ts",
"./src/context/main.ts",
```

Verify with:

```bash
grep -n "src/context" package.json
```

Expected output: five lines, one per file under `src/context/`, no remaining reference to `./src/context.ts`.

The `exports` map in `package.json` does NOT reference `src/context` directly (verified — only `index.ts` exposes the context surface to consumers), so no `exports` change needed.

- [ ] **Step 4: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS. The OLD `src/context.ts` is still present (deleted in Task 10), so legacy imports in `tests/context.spec.ts` continue to resolve cleanly until Task 8 removes that test file.

- [ ] **Step 5: Commit**

```bash
git add providers/provider.ts src/exception_handler.ts index.ts package.json
git commit -m "refactor(context): migrate provider + exception_handler + index to new module"
```

---

## Task 7: Update `factories/xrpc.ts` with overloaded `create()`

**Files:**
- Modify: `factories/xrpc.ts`

The factory's `create()` becomes overloaded — three signatures (per-kind narrowed + wide fallback) plus the implementation. Runtime branches on `lexicon.type` to construct the right subclass; the wide-union narrowing on `XrpcLexicon` lets the implementation body use TypeScript's natural discriminated-union flow analysis without an `as L` cast on the lexicon.

- [ ] **Step 1: Replace `factories/xrpc.ts` with the new implementation**

```ts
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import type { HttpRequest } from '@adonisjs/core/http'
import type { Logger } from '@adonisjs/core/logger'
import type { ContainerResolver } from '@adonisjs/core/container'
import {
  XrpcHttpContext,
  XrpcSubscriptionContext,
  type XrpcContext,
} from '../src/context/main.js'
import type {
  InferInput,
  InferParams,
  XrpcLexicon,
  XrpcProcedureLexicon,
  XrpcQueryLexicon,
  XrpcSubscriptionLexicon,
} from '../src/types.js'

interface MergeParams<L extends XrpcLexicon> {
  lexicon: L
  request: HttpRequest
  input: unknown
  params: Record<string, any>
  signal: AbortSignal
  logger: Logger
  containerResolver: ContainerResolver<any>
  requestId: string
}

/**
 * Test-facing builder for XRPC contexts. Carries sensible defaults for every
 * field — tests merge only the fields that matter for the assertion under
 * test, parallel to Adonis's HttpContextFactory. Defaults derive from a
 * fresh HttpContextFactory().create() (same source the production HTTP-path
 * materialization uses via fromHttpContext() in Plan 03), so test fixtures
 * stay aligned with real dispatch.
 *
 * `create()` is overloaded so the inferred lexicon kind picks the concrete
 * subclass return type at the call site. The runtime branches on
 * `lexicon.type` to construct the matching subclass.
 */
export class XrpcContextFactory {
  #params: Partial<MergeParams<XrpcLexicon>> = {}

  merge(params: Partial<MergeParams<XrpcLexicon>>): this {
    this.#params = { ...this.#params, ...params }
    return this
  }

  // Overload 1: subscription lexicons → XrpcSubscriptionContext.
  create<L extends XrpcSubscriptionLexicon>(): XrpcSubscriptionContext<L>
  // Overload 2: query/procedure lexicons → XrpcHttpContext.
  create<L extends XrpcQueryLexicon | XrpcProcedureLexicon>(): XrpcHttpContext<L>
  // Overload 3 (wide fallback): the union alias for callers passing the
  // wide XrpcLexicon constraint.
  create<L extends XrpcLexicon>(): XrpcContext<L>
  // Implementation signature.
  create<L extends XrpcLexicon>(): XrpcContext<L> {
    // No `as L` cast — discriminated-union narrowing on lexicon.type works
    // against the XrpcLexicon union naturally. The L parameterization is
    // confined to the return cast.
    const lexicon = this.#params.lexicon
    if (!lexicon) {
      throw new Error(
        'XrpcContextFactory: lexicon is required — call .merge({ lexicon }) first'
      )
    }

    const httpCtx = new HttpContextFactory().create()
    const shared = {
      request: this.#params.request ?? httpCtx.request,
      signal: this.#params.signal ?? new AbortController().signal,
      logger: this.#params.logger ?? httpCtx.logger,
      containerResolver: this.#params.containerResolver ?? httpCtx.containerResolver,
      requestId: this.#params.requestId ?? httpCtx.request.id() ?? 'test-req-id',
    }

    if (lexicon.type === 'xrpc_subscription') {
      // lexicon narrowed to XrpcSubscriptionLexicon via discriminated union.
      return new XrpcSubscriptionContext({
        ...shared,
        lexicon,
        params: (this.#params.params ?? {}) as InferParams<XrpcSubscriptionLexicon>,
      }) as XrpcContext<L>
    }

    // lexicon narrowed to XrpcQueryLexicon | XrpcProcedureLexicon.
    return new XrpcHttpContext({
      ...shared,
      lexicon,
      params: (this.#params.params ?? {}) as InferParams<
        XrpcQueryLexicon | XrpcProcedureLexicon
      >,
      input: this.#params.input as InferInput<XrpcQueryLexicon | XrpcProcedureLexicon>,
    }) as XrpcContext<L>
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run the factory test (single file)**

```bash
pnpm quick:test --files 'tests/factory.spec.ts'
```

Some tests may fail — `tests/factory.spec.ts` imports `XrpcContext` as a value (the old class). Those tests get updated in Task 9. If the failures look like missing `XrpcContext` class import, that's expected and resolved in Task 9.

- [ ] **Step 4: Commit**

```bash
git add factories/xrpc.ts
git commit -m "refactor(factory): overload XrpcContextFactory.create per lexicon kind"
```

---

## Task 8: Migrate `tests/context.spec.ts` content into per-class spec files

**Files:**
- Delete: `tests/context.spec.ts`

The content of the old `tests/context.spec.ts` has been split into `tests/context/{operation,http,subscription,helpers}.spec.ts` across Tasks 1–4. At this point, the old file's tests are either:

1. **Duplicated** by the new per-class specs (response state, stream helpers, ALS scope, Macroable) — drop these from the old file.
2. **Obsolete** because they tested the now-deleted single `XrpcContext` class shape (`XrpcContext — construction`, `XrpcContext.get / .getOrFail — ALS`, the macro presence on the singular `XrpcContext`) — drop these too.

Verify the new specs cover everything the old file did before deleting.

- [ ] **Step 1: Verify coverage**

```bash
pnpm quick:test --files 'tests/context/*.spec.ts'
```

Expected: all 4 files pass. Compare to the original `tests/context.spec.ts` test names to confirm every assertion has a corresponding test in the new files. Specifically check:

| Original test name | Migrated to |
|---|---|
| `exposes the materialized primitives directly` | `tests/context/http.spec.ts` AND `tests/context/subscription.spec.ts` (one per subclass) |
| `procedure-kind context exposes response as XrpcResponse` | `tests/context/http.spec.ts` (`exposes response as XrpcResponse instance`) |
| `subscription-kind context exposes response as XrpcStream` | `tests/context/subscription.spec.ts` (`exposes stream as XrpcStream instance`) |
| `XrpcContext.get / .getOrFail — ALS` (4 tests) | `tests/context/http.spec.ts` + `tests/context/subscription.spec.ts` (per-subclass) + `tests/context/operation.spec.ts` (base) |
| `XrpcResponse — chainable setters` (5 tests) | `tests/context/http.spec.ts` (`XrpcHttpContext — response state` group) |
| `XrpcStream — subscription helpers` (2 tests) | `tests/context/subscription.spec.ts` (`XrpcSubscriptionContext — stream helpers` group) |
| `Macroable extension points` | Split across the three per-class specs (each verifies its class's `.macro` field) |

If any test is missing, add it to the appropriate per-class spec before deleting the old file.

- [ ] **Step 2: Delete `tests/context.spec.ts`**

```bash
rm tests/context.spec.ts
```

- [ ] **Step 3: Run the full test suite**

```bash
pnpm test
```

Expected: PASS. Lint + typecheck + tests all green.

If lint or typecheck still flags issues from other files (`tests/provider_error_reporting.spec.ts`, `tests/xrpc_server.spec.ts`, `tests/factory.spec.ts`), those get fixed in Task 9.

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test(context): migrate context.spec.ts into per-class spec files"
```

---

## Task 9: Update remaining test files

**Files:**
- Modify: `tests/provider_error_reporting.spec.ts`
- Modify: `tests/xrpc_server.spec.ts`
- Modify: `tests/factory.spec.ts`

These tests reference the old `XrpcContext` symbol or its ALS in ways that need updating to the new module.

- [ ] **Step 1: Update `tests/provider_error_reporting.spec.ts`**

Replace the imports (lines 17–18 region):

Before:
```ts
import type { XrpcContext } from '../src/context.js'
import type { XrpcLexicon } from '../src/types.js'
```

After:
```ts
import type { XrpcOperationContext } from '../src/context/main.js'
```

(Verify `XrpcLexicon` isn't used elsewhere in the file first: `grep -n "XrpcLexicon" tests/provider_error_reporting.spec.ts`. If still used, keep that import; only drop the `XrpcContext` import.)

Then update the reporter type — `XrpcContext<XrpcLexicon> | null` becomes `XrpcOperationContext | null`. Apply this to BOTH occurrences inside the test (the `reportCalls` array declaration AND the `SpyHandler.report` override signature):

```ts
const reportCalls: Array<{ err: unknown; ctx: XrpcOperationContext | null }> = []
const handleReturn = new NotFoundError('sanitized in handle()')

class SpyHandler extends ExceptionHandler {
  override async report(err: unknown, ctx: XrpcOperationContext | null) {
    reportCalls.push({ err, ctx })
  }
  override async handle(_err: unknown) {
    return handleReturn
  }
}
```

There may be multiple test cases inside the file with the same pattern (a `SpyHandler` per test). Update each. Confirm with:

```bash
grep -n "XrpcContext<XrpcLexicon>" tests/provider_error_reporting.spec.ts
```

Expected output after edit: empty (no matches).

- [ ] **Step 2: Update `tests/xrpc_server.spec.ts`**

Replace the import (line 12):

Before:
```ts
import { XrpcContext } from '../src/context.js'
```

After:
```ts
import { XrpcSubscriptionContext } from '../src/context/main.js'
```

The single usage at line 297 is inside a subscription-path test (`'XrpcContext.als is in scope during each yielded value (per-.next() ALS re-entry)'`). Update to use the subclass accessor — the runtime context in scope is a subscription context, so `XrpcSubscriptionContext.get()` is the right shape and gives typed `.lexicon` access without the `as any` cast:

Before (around lines 288–300):
```ts
test('XrpcContext.als is in scope during each yielded value (per-.next() ALS re-entry)', async ({
  assert,
}) => {
  const observed: { nsid: string | undefined }[] = []
  const executor = executorWithFn(STREAM, async function* () {
    for (let n = 1; n <= 3; n++) {
      const fromAls = XrpcContext.als.getStore()
      observed.push({ nsid: (fromAls?.lexicon as any)?.nsid })
      yield { $type: 'com.example.stream#tick', n }
    }
  })
```

After:
```ts
test('XrpcOperationContext.als is in scope during each yielded value (per-.next() ALS re-entry)', async ({
  assert,
}) => {
  const observed: { nsid: string | undefined }[] = []
  const executor = executorWithFn(STREAM, async function* () {
    for (let n = 1; n <= 3; n++) {
      const fromAls = XrpcSubscriptionContext.get()
      observed.push({ nsid: fromAls?.lexicon.nsid })
      yield { $type: 'com.example.stream#tick', n }
    }
  })
```

The test name also updates from "`XrpcContext.als`" to "`XrpcOperationContext.als`" for accuracy. The `(... as any)` cast is no longer needed because `XrpcSubscriptionContext.get()` returns a typed context where `lexicon` is `XrpcSubscriptionLexicon` and `.nsid` is part of that type.

- [ ] **Step 3: Update `tests/factory.spec.ts`**

Replace the imports (lines 1–5):

Before:
```ts
import { test } from '@japa/runner'
import { XrpcContextFactory } from '../factories/xrpc.js'
import { XrpcContext } from '../src/context.js'
import { XrpcResponse } from '../src/response.js'
import { XrpcStream } from '../src/stream.js'
```

After:
```ts
import { test } from '@japa/runner'
import { XrpcContextFactory } from '../factories/xrpc.js'
import { XrpcHttpContext, XrpcSubscriptionContext } from '../src/context/main.js'
import { XrpcResponse } from '../src/response.js'
import { XrpcStream } from '../src/stream.js'
```

Then update the assertions that depended on the old single `XrpcContext` class. The current file (verified against the working tree) has these specific tests that need updates:

**Test 1: "creates an XrpcContext with defaults for procedure-kind lexicons"** (line 15)

Before:
```ts
test('creates an XrpcContext with defaults for procedure-kind lexicons', ({ assert }) => {
  const ctx = new XrpcContextFactory().merge({ lexicon: procedureLex }).create()
  assert.instanceOf(ctx, XrpcContext)
  assert.instanceOf(ctx.response, XrpcResponse)
  assert.deepEqual(ctx.params, {})
  assert.equal(ctx.input, undefined)
})
```

After:
```ts
test('creates an XrpcHttpContext with defaults for procedure-kind lexicons', ({ assert }) => {
  const ctx = new XrpcContextFactory().merge({ lexicon: procedureLex }).create()
  assert.instanceOf(ctx, XrpcHttpContext)
  assert.instanceOf(ctx.response, XrpcResponse)
  assert.deepEqual(ctx.params, {})
  assert.equal(ctx.input, undefined)
})
```

**Test 2: "creates an XrpcContext with defaults for subscription-kind lexicons"** (line 23)

Before:
```ts
test('creates an XrpcContext with defaults for subscription-kind lexicons', ({ assert }) => {
  const ctx = new XrpcContextFactory().merge({ lexicon: subscriptionLex }).create()
  assert.instanceOf(ctx.response, XrpcStream)
})
```

After:
```ts
test('creates an XrpcSubscriptionContext with defaults for subscription-kind lexicons', ({
  assert,
}) => {
  const ctx = new XrpcContextFactory().merge({ lexicon: subscriptionLex }).create()
  assert.instanceOf(ctx, XrpcSubscriptionContext)
  assert.instanceOf(ctx.stream, XrpcStream)
})
```

Note the field rename: subscription context exposes `.stream`, not `.response`. This is the correct shape post-refactor.

**Tests 3 + 4** ("forwards merged input / params overrides", "defaults logger / containerResolver / request from a fresh HttpContextFactory") don't reference `XrpcContext` by name and don't need import-related changes — they should typecheck and run without edits.

- [ ] **Step 4: Run the full test suite**

```bash
pnpm test
```

Expected: PASS — lint + typecheck + all tests green.

- [ ] **Step 5: Commit**

```bash
git add tests/provider_error_reporting.spec.ts tests/xrpc_server.spec.ts tests/factory.spec.ts
git commit -m "test(context): update remaining test files for new context module"
```

---

## Task 10: Delete `src/context.ts`

**Files:**
- Delete: `src/context.ts`

All callers now import from `src/context/main.ts`. The old single-file module is dead code.

- [ ] **Step 1: Verify nothing imports from `./context.js` directly**

```bash
grep -rn "from.*'.*context\.js'\|from.*'.*context\.ts'" src/ providers/ factories/ tests/ index.ts | grep -v "context/main" | grep -v "context/operation" | grep -v "context/http" | grep -v "context/subscription" | grep -v "context/helpers" | grep -v "request_context\|http_context"
```

Expected output: empty (no matches). If anything matches, those callers still point at the old module — update them first.

- [ ] **Step 2: Delete the file**

```bash
rm src/context.ts
```

- [ ] **Step 3: Run the full test suite**

```bash
pnpm test
```

Expected: PASS — lint + typecheck + all tests green.

- [ ] **Step 4: Verify the published-type shape still passes attw**

```bash
pnpm types:check
```

Expected: PASS. This guards against breaking the published subpath exports.

- [ ] **Step 5: Commit**

```bash
git add src/
git commit -m "refactor(context): delete src/context.ts (replaced by src/context/ module)"
```

---

## Self-review checkpoint (executor performs before declaring done)

Before declaring the plan complete:

- [ ] **Step 1: Full pipeline green**

```bash
pnpm test
```

Lint, typecheck, and all tests pass.

- [ ] **Step 2: attw passes**

```bash
pnpm types:check
```

The published-type surface is intact.

- [ ] **Step 3: Build succeeds**

```bash
pnpm build
```

`tsdown` + `tsc --emitDeclarationOnly` + copy-templates all succeed. No reference errors in the build output.

- [ ] **Step 4: Add a changeset**

```bash
pnpm changeset
```

Select `patch` (this is internal-only — no released consumers yet per the package's brand-new status), with a description like:

> Restructure `XrpcContext` as a discriminated union (`XrpcOperationContext` base + `XrpcHttpContext` + `XrpcSubscriptionContext`). The public `XrpcContext<L>` symbol becomes a type alias that resolves to the concrete subclass; handler signatures `(ctx: XrpcContext<typeof myLex>) => ...` work unchanged.

Commit the generated changeset file:

```bash
git add .changeset/
git commit -m "chore: add changeset for context discriminated-union refactor"
```

---

## Post-merge cleanup (manual, not an executable task)

After this plan is merged, perform once:

1. **Delete the superseded memory note.** The file lives at `~/.claude/projects/-Users-emelia-Development-git-github-com-thisismissem-adonisjs-atproto-xrpc/memory/xrpc-context-response-narrowing.md`. The refactor resolved the issue it documented; the note is now misleading point-in-time history.
2. **Remove the entry from `MEMORY.md`** in the same directory: the line `- [XrpcContext.response conditional-type narrowing](xrpc-context-response-narrowing.md) — handler authors need to cast \`ctx.response\` even with known lexicon kind; consider narrowing helpers or concrete subtypes in Plan 03/04 before consumers arrive.`
3. **Optional: consider deleting the `xrpc-todo-pre-release-items` entry** if its `XrpcRouter generic narrowing` and `XrpcResponseBody / InferOutput reconciliation` items are resolved by this refactor. Check `TODO.md` to confirm before removing.

These cleanups are session-local and don't affect the repository state.
