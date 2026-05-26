# XRPC Plan 01 — Core Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Model:** Claude Sonnet (current generation) — the design and audit work is settled in the spec and plans; execution is mechanical enough that Opus is overkill.

**Goal:** Ship the foundational primitives the rest of the package builds on — lexicon types, error hierarchy, config helper, route declaration builders, runtime context types, and the test factory — without any auth surface and without the serializer.

**Architecture:** Pure declaration- and shape-layer code. No dispatch, no provider lifecycle, no WebSocket, no transformer-contract serialization. The `XrpcRouter` accumulates declarations; the `XrpcContext` carries request/response state via Macroable. `XrpcAuth` is intentionally absent — auth ships in Plan 05 (after dispatch + provider are working) as a Macroable plugin demonstration; the serializer ships in Plan 02.

**Tech Stack:** TypeScript (ESM), Node ≥24, `@poppinss/macroable`, `@atcute/lexicons`, `@japa/runner` + `@japa/assert` for tests.

**Spec reference:** `docs/specs/2026-05-21-adonisjs-atproto-xrpc-design.md` — the canonical design this plan implements.

---

## Files

### Create

- `src/errors.ts` — `XrpcError` base + 8 built-in subclasses
- `src/router.ts` — `XrpcRouter`, `XrpcRoute`, `XrpcRouteGroup` (Macroable; no auth)
- `src/utils.ts` — `adonisRequestToWebRequest` + `writeWebResponseToAdonisResponse`
- `src/context.ts` — `XrpcContext`, `XrpcResponse`, `XrpcStream` (Macroable; ALS-based static accessors)
- `src/exception_handler.ts` — `ExceptionHandler` base class (the consumer's `app/exceptions/xrpc_handler.ts` extends this); ships defaults for `shouldReport()`, `report()` (no-op), `handle()` (sanitize to `InternalServerError` in production, preserve cause in dev)
- `factories/xrpc.ts` — `XrpcContextFactory`
- `stubs/app/exceptions/xrpc_handler.stub` — consumer-facing stub that the configure command publishes to `app/exceptions/xrpc_handler.ts`; subclass of `ExceptionHandler` with thin `super`-delegating bodies for `report()` and `handle()` (the Adonis stub convention)
- `tests/errors.spec.ts`
- `tests/router.spec.ts`
- `tests/utils.spec.ts`
- `tests/context.spec.ts`
- `tests/exception_handler.spec.ts`
- `tests/factory.spec.ts`

### Modify

- `package.json` — add deps + subpath exports + extend `tsdown.entry`
- `src/types.ts` — re-export lexicon-type primitives from `@atcute/lexicons`; add `XrpcLexicon`, `XrpcProcedureLexicon`, `XrpcQueryLexicon`, `XrpcSubscriptionLexicon`, `InferInput`, `InferParams`, `InferOutput`, `XrpcMessage` aliases plus the `XrpcConfig` surface. Also carries the `declare module '@adonisjs/core/http' { interface Router { xrpc: XrpcRouter } }` augmentation (appended after `src/router.ts` exists — Task 6 Step 4) so `router.xrpc` is typed everywhere `src/types.ts` is in scope without per-file side-effect imports
- `src/define_config.ts` — strengthen typing once `XrpcProviderConfig` has real fields (`serviceDid` is required; other fields land in later plans)
- `configure.ts` — verify `useAsyncLocalStorage: true`; prompt to enable if missing
- `stubs/config.stub` — populate with `serviceDid` example
- `index.ts` — extend public re-exports

### Out of scope (later plans)

- `src/serializer.ts` (XrpcSerializer) → Plan 02
- `src/xrpc_server.ts`, `src/middleware/dispatch.ts`, WebSocket upgrade → Plan 03
- `providers/provider.ts` refactor, `services/xrpc.ts`, `services/router.ts` → Plan 04
- `src/auth.ts`, `.serviceAuth()`, `ctx.auth`, `XrpcAuthResult`, `isService` → Plan 05
- `commands/list_xrpc_routes.ts`, `commands/make_xrpc_controller.ts` → Plan 06
- `hooks/index_xrpc.ts` → Plan 07

Plans 05-07 are deferred to a separate spec + planning cycle once we have the basic integration working.

---

## Pre-flight checks

- [ ] **Step 0a: Confirm we are on a clean working tree and the spec is the latest committed**

Run:

```bash
git status
git log --oneline -5
```

Expected: working tree clean (or only the plan file untracked); `311213f Add design spec for adonisjs-atproto-xrpc package` reachable.

- [ ] **Step 0b: Confirm `@atcute/lexicons` exports the lexicon-type names this plan depends on**

We need `XrpcProcedureLexicon | XrpcQueryLexicon | XrpcSubscriptionLexicon`, plus the `infer*` helpers. Names may differ from the spec aliases.

Run:

```bash
pnpm info @atcute/lexicons exports
pnpm info @atcute/lexicons version
```

Expected: package resolves; subpath exports include type definitions. If the exports use different names (e.g. `XrpcLexiconDef` instead of `XrpcLexicon`), record the actual names — the type re-exports in Task 2 must match the upstream names exactly. Update Task 2's import lines if the upstream names differ from the spec's nominal names.

---

## Task 1: Add dependencies

**Files:**

Modify: `package.json` (dependencies + peerDependencies + tsdown.entry)

**Steps:**

- [ ] **Step 1: Add runtime dependencies via pnpm**

Run:

```bash
pnpm add @atcute/lexicons @poppinss/macroable
```

Expected: two entries added under `dependencies` in `package.json`; lockfile updated. No build/postinstall failures. (`@adonisjs/http-transformers` lands in Plan 02 with the serializer.)

- [ ] **Step 2: Run typecheck to confirm the package resolves cleanly**

Run: `pnpm typecheck`
Expected: zero errors (existing scaffolding is small and unchanged at this point).

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "feat(xrpc): add @atcute/lexicons and @poppinss/macroable deps"
```

---

## Task 2: Lexicon-type primitives in `src/types.ts`

**Files:**

- Modify: `src/types.ts`

The current file contains placeholder `XrpcProviderConfig = {}` and `XrpcConfig = XrpcProviderConfig`. We replace those with the real type surface. (No dedicated TDD step for types — downstream tasks that import from `src/types.ts` will fail typecheck if anything's missing, and Task 4's `defineConfig` test directly exercises `XrpcConfig`.)

**Steps:**

- [ ] **Step 1: Replace `src/types.ts` with the full type surface**

Replace the contents of `src/types.ts` with (adjust the `@atcute/lexicons` import names if Step 0b revealed different upstream names):

```ts
/*
|--------------------------------------------------------------------------
| Lexicon type primitives and package config typing
|--------------------------------------------------------------------------
*/

import type {
  // The names below are the spec's nominal names. Verify against the actual
  // @atcute/lexicons exports during Step 0b; rename here if upstream differs.
  XrpcProcedureLexicon as AtcuteXrpcProcedureLexicon,
  XrpcQueryLexicon as AtcuteXrpcQueryLexicon,
  XrpcSubscriptionLexicon as AtcuteXrpcSubscriptionLexicon,
  InferInput as AtcuteInferInput,
  InferParams as AtcuteInferParams,
  InferOutput as AtcuteInferOutput,
  InferMessage as AtcuteInferMessage,
} from '@atcute/lexicons'

// Lexicon-shape re-exports. We re-export under our own names so consumers
// can import everything from this package without reaching into atcute.
// If atcute ever renames these, the alias layer absorbs the change.
export type XrpcProcedureLexicon = AtcuteXrpcProcedureLexicon
export type XrpcQueryLexicon = AtcuteXrpcQueryLexicon
export type XrpcSubscriptionLexicon = AtcuteXrpcSubscriptionLexicon
export type XrpcLexicon = XrpcProcedureLexicon | XrpcQueryLexicon | XrpcSubscriptionLexicon

export type InferInput<L extends XrpcLexicon> = AtcuteInferInput<L>
export type InferParams<L extends XrpcLexicon> = AtcuteInferParams<L>
export type InferOutput<L extends XrpcLexicon> = AtcuteInferOutput<L>
export type XrpcMessage<L extends XrpcSubscriptionLexicon> = AtcuteInferMessage<L>

/**
 * Union of `#ref` discriminator suffixes declared by a subscription lexicon.
 * Derived from the `$type` field of each variant in `XrpcMessage<L>` — the
 * full `$type` is `<NSID><#ref>`, so we strip the NSID prefix to get the
 * `#ref` portion.
 *
 * Used by `XrpcStream.message(ref, payload)` to narrow `ref` to refs the
 * lexicon actually declares — typo-rejecting at compile time.
 */
export type XrpcMessageRef<L extends XrpcSubscriptionLexicon> =
  XrpcMessage<L> extends { $type: infer T extends string }
    ? T extends `${string}#${infer Ref}`
      ? `#${Ref}`
      : never
    : never

/**
 * The payload shape for a specific message ref within a subscription
 * lexicon — the matching variant of the discriminated union minus its
 * `$type` field (which `XrpcStream.message` synthesizes from the NSID + ref).
 */
export type XrpcMessagePayload<
  L extends XrpcSubscriptionLexicon,
  R extends XrpcMessageRef<L>,
> = Omit<Extract<XrpcMessage<L>, { $type: `${string}${R}` }>, '$type'>

/**
 * Type aliases for forward-compat. These are the surface area later plans
 * augment via declaration merging — Plan 05 (auth) will extend
 * `XrpcProviderConfig` with a `resolver` field, and Plan 03 (dispatch) will
 * surface NSID-typed helpers. v1 starts with `serviceDid` as the only
 * required field.
 */
export interface XrpcProviderConfig {
  /** The DID of this service. Becomes the `aud` claim for incoming service JWTs. */
  serviceDid: `did:${string}`
}

export type XrpcConfig = XrpcProviderConfig
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(xrpc): replace placeholder types with @atcute/lexicons-backed surface"
```

---

## Task 3: Error hierarchy in `src/errors.ts`

**Files:**

- Create: `src/errors.ts`
- Create: `tests/errors.spec.ts`

**Steps:**

- [ ] **Step 1: Implement `src/errors.ts`**

Create `src/errors.ts`:

```ts
import { Exception } from '@poppinss/exception'

/**
 * Base class for all XRPC-domain errors. Three orthogonal name slots:
 *
 * - `name` (inherited from Error): JS class name, used for stack traces and
 *   `instanceof` discrimination.
 * - `code`: machine-readable JS-level error code, used for log filtering and
 *   error-recovery routing in the host application.
 * - `errorName`: atproto wire-format error category. Goes into the `error`
 *   field of the XRPC wire response and matches the lexicon's `errors[].name`.
 */
export class XrpcError extends Exception {
  static status = 500
  static code = 'E_XRPC_ERROR'
  static errorName = 'InternalServerError'

  get errorName(): string {
    return (this.constructor as typeof XrpcError).errorName
  }
}

export class AuthRequiredError extends XrpcError {
  static status = 401
  static code = 'E_AUTH_REQUIRED'
  static errorName = 'AuthenticationRequired'
}

export class ForbiddenError extends XrpcError {
  static status = 403
  static code = 'E_FORBIDDEN'
  static errorName = 'Forbidden'
}

export class InvalidRequestError extends XrpcError {
  static status = 400
  static code = 'E_INVALID_REQUEST'
  static errorName = 'InvalidRequest'
}

export class NotFoundError extends XrpcError {
  static status = 404
  static code = 'E_NOT_FOUND'
  static errorName = 'NotFound'
}

export class RateLimitExceededError extends XrpcError {
  static status = 429
  static code = 'E_RATE_LIMITED'
  static errorName = 'RateLimitExceeded'
}

export class InternalServerError extends XrpcError {
  static status = 500
  static code = 'E_INTERNAL_ERROR'
  static errorName = 'InternalServerError'
}

export class UpstreamFailureError extends XrpcError {
  static status = 502
  static code = 'E_UPSTREAM_FAILURE'
  static errorName = 'UpstreamFailure'
}

export class NotEnoughResourcesError extends XrpcError {
  static status = 503
  static code = 'E_NOT_ENOUGH_RESOURCES'
  static errorName = 'NotEnoughResources'
}

export class UpstreamTimeoutError extends XrpcError {
  static status = 504
  static code = 'E_UPSTREAM_TIMEOUT'
  static errorName = 'UpstreamTimeout'
}
```

- [ ] **Step 2: Write tests for the error hierarchy**

Create `tests/errors.spec.ts`:

```ts
import { test } from '@japa/runner'
import {
  XrpcError,
  AuthRequiredError,
  ForbiddenError,
  InvalidRequestError,
  RateLimitExceededError,
  InternalServerError,
  UpstreamFailureError,
  NotEnoughResourcesError,
  UpstreamTimeoutError,
} from '../src/errors.js'

test.group('XrpcError', () => {
  test('XrpcError defaults: status 500, code E_XRPC_ERROR, errorName InternalServerError', ({
    assert,
  }) => {
    const err = new XrpcError('boom')
    assert.equal(err.message, 'boom')
    assert.equal(XrpcError.status, 500)
    assert.equal(XrpcError.code, 'E_XRPC_ERROR')
    assert.equal(XrpcError.errorName, 'InternalServerError')
    assert.equal(err.errorName, 'InternalServerError')
  })

  test('subclasses each pin status / code / errorName', ({ assert }) => {
    const cases: Array<{
      cls: typeof XrpcError
      status: number
      code: string
      errorName: string
    }> = [
      {
        cls: AuthRequiredError,
        status: 401,
        code: 'E_AUTH_REQUIRED',
        errorName: 'AuthenticationRequired',
      },
      { cls: ForbiddenError, status: 403, code: 'E_FORBIDDEN', errorName: 'Forbidden' },
      {
        cls: InvalidRequestError,
        status: 400,
        code: 'E_INVALID_REQUEST',
        errorName: 'InvalidRequest',
      },
      {
        cls: RateLimitExceededError,
        status: 429,
        code: 'E_RATE_LIMITED',
        errorName: 'RateLimitExceeded',
      },
      {
        cls: InternalServerError,
        status: 500,
        code: 'E_INTERNAL_ERROR',
        errorName: 'InternalServerError',
      },
      {
        cls: UpstreamFailureError,
        status: 502,
        code: 'E_UPSTREAM_FAILURE',
        errorName: 'UpstreamFailure',
      },
      {
        cls: NotEnoughResourcesError,
        status: 503,
        code: 'E_NOT_ENOUGH_RESOURCES',
        errorName: 'NotEnoughResources',
      },
      {
        cls: UpstreamTimeoutError,
        status: 504,
        code: 'E_UPSTREAM_TIMEOUT',
        errorName: 'UpstreamTimeout',
      },
    ]
    for (const { cls, status, code, errorName } of cases) {
      assert.equal(cls.status, status, `${cls.name}.status`)
      assert.equal(cls.code, code, `${cls.name}.code`)
      assert.equal(cls.errorName, errorName, `${cls.name}.errorName`)
      const instance = new cls('x')
      assert.equal(instance.errorName, errorName, `${cls.name}#errorName`)
      assert.instanceOf(instance, XrpcError, `${cls.name} extends XrpcError`)
    }
  })

  test('Error.cause is preserved when passed in options', ({ assert }) => {
    const cause = new Error('underlying')
    const err = new InvalidRequestError('wrapper', { cause })
    assert.equal(err.cause, cause)
  })
})
```

- [ ] **Step 3: Verify `@poppinss/exception` is reachable**

Run: `pnpm info @poppinss/exception version`
Expected: a version string. If not installed, run `pnpm add @poppinss/exception` and re-run the typecheck. (It is normally a transitive dep of `@adonisjs/core`, but make it explicit because we import from it directly.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm quick:test --files tests/errors.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts tests/errors.spec.ts package.json pnpm-lock.yaml
git commit -m "feat(xrpc): add XrpcError hierarchy with 8 built-in subclasses"
```

---

## Task 4: Strengthen `defineConfig` typing + runtime DID validation

**Files:**

- Modify: `src/define_config.ts`
- Modify: `tests/define_config.spec.ts`

The compile-time `serviceDid: \`did:${string}\``constraint catches static literals but doesn't help when the value comes from`env.get(...)`(typed as`string`) — a typo in `.env`slips through.`defineConfig`validates at runtime using`@atcute/lexicons`'s `isDid` guard so a bad value fails fast at boot rather than producing confusing service-JWT verification errors later.

We delegate to atcute's canonical DID guard rather than rolling our own regex: atcute is the source of truth for what counts as a valid DID across the rest of the package (and across consumer code that already imports from `@atcute/*`). A single canonical guard means service-JWT verification, identity resolution, and config validation all agree on the syntax.

**Steps:**

- [ ] **Step 1: Verify atcute's DID guard import path**

Atcute exposes a DID guard, but the exact subpath / name varies across versions. Confirm the canonical import before writing the implementation:

```bash
pnpm info @atcute/lexicons exports | grep -i did
node -e "console.log(Object.keys(await import('@atcute/lexicons')).filter(k => k.toLowerCase().includes('did')))"
```

Expected: either `isDid` is exported from `@atcute/lexicons` directly, or it lives under a subpath like `@atcute/lexicons/syntax`. If the guard is named differently (`isValidDid`, `validateDid`, etc.), or if it's a branded-type guard whose signature differs from `(value: unknown) => value is Did`, adjust the Step 4 import line and call site accordingly.

If no DID guard is available from atcute (e.g. you're on an older version that doesn't expose one), fall back to the regex inlined in the previous draft of this task — `^did:[a-z0-9]+:[a-zA-Z0-9._:%-]+$` — and note the fallback in the commit message.

- [ ] **Step 2: Update `src/define_config.ts`**

Replace its contents with (adjusting the `isDid` import per Step 1):

```ts
import { isDid } from '@atcute/lexicons'
import { InvalidArgumentsException } from '@poppinss/utils'
import type { XrpcConfig, XrpcProviderConfig } from './types.js'

/**
 * Validates and returns the package config. Throws `InvalidArgumentsException`
 * if `serviceDid` is not a syntactically-valid DID — a bad value here would
 * otherwise surface much later as opaque service-JWT verification failures.
 *
 * Delegates the DID-syntax check to `@atcute/lexicons`'s `isDid` guard so all
 * package + consumer code agrees on what counts as a DID (resolver, JWT
 * verifier, config validator).
 *
 * The generic `T` keeps the call site's literal types intact so future config
 * fields can be inferred from the consumer's defineConfig() call.
 */
export function defineConfig<T extends XrpcProviderConfig>(config: T): T & XrpcConfig {
  if (!isDid(config.serviceDid)) {
    throw new InvalidArgumentsException(
      `defineConfig: serviceDid must be a valid DID (e.g. "did:plc:..." or "did:web:...") — got ${JSON.stringify(config.serviceDid)}`
    )
  }
  return config
}
```

- [ ] **Step 3: Write tests for defineConfig**

Replace `tests/define_config.spec.ts` with:

```ts
import { test } from '@japa/runner'
import { defineConfig } from '../src/define_config.js'

test.group('defineConfig — happy path', () => {
  test('returns the same object passed in (passthrough)', ({ assert }) => {
    const input = { serviceDid: 'did:plc:example' as const }
    const result = defineConfig(input)
    assert.deepEqual(result, input)
  })

  test('accepts did:plc identifiers', ({ assert }) => {
    const result = defineConfig({ serviceDid: 'did:plc:abc123xyz' })
    assert.equal(result.serviceDid, 'did:plc:abc123xyz')
  })

  test('accepts did:web identifiers with hostnames', ({ assert }) => {
    const result = defineConfig({ serviceDid: 'did:web:example.com' })
    assert.equal(result.serviceDid, 'did:web:example.com')
  })

  test('accepts did:web identifiers with ports and paths', ({ assert }) => {
    const result = defineConfig({ serviceDid: 'did:web:example.com%3A8443:user:alice' })
    assert.equal(result.serviceDid, 'did:web:example.com%3A8443:user:alice')
  })
})

test.group('defineConfig — rejects malformed serviceDid', () => {
  const badInputs: Array<[string, unknown]> = [
    ['empty string', ''],
    ['plain identifier', 'not-a-did'],
    ['missing method', 'did::example'],
    ['missing id', 'did:plc:'],
    ['uppercase method', 'did:PLC:abc'],
    ['leading whitespace', ' did:plc:abc'],
    ['trailing whitespace', 'did:plc:abc '],
    ['null value', null],
    ['number value', 123],
  ]

  for (const [label, value] of badInputs) {
    test(`rejects ${label}`, ({ assert }) => {
      assert.throws(() => defineConfig({ serviceDid: value as any }), /serviceDid/)
    })
  }
})
```

- [ ] **Step 4: Verify `@poppinss/utils` is reachable**

Run: `pnpm info @poppinss/utils version`
Expected: a version string. It's a transitive dep of `@adonisjs/core`; if for any reason `InvalidArgumentsException` isn't importable from the package root, fall back to `import { InvalidArgumentsException } from '@poppinss/utils/exception'` or substitute `RuntimeException` from `@adonisjs/core/exceptions`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm quick:test --files tests/define_config.spec.ts`
Expected: PASS — 13 tests (4 happy-path + 9 rejection cases). If atcute's `isDid` is stricter or looser than expected on a specific case (e.g. it rejects the percent-encoded did:web example, or accepts something the rejection list expects to fail), adjust the test fixtures to reflect atcute's actual contract rather than fighting it — atcute is the source of truth.

- [ ] **Step 6: Commit**

```bash
git add src/define_config.ts tests/define_config.spec.ts
git commit -m "feat(xrpc): defineConfig validates serviceDid via @atcute/lexicons isDid"
```

---

## Task 5: Refine `configure.ts` to publish the handler stub + verify `useAsyncLocalStorage`

**Files:**

- Modify: `configure.ts`
- Modify: `stubs/config.stub`
- Create: `stubs/app/exceptions/xrpc_handler.stub`
- Modify: `tests/configure.spec.ts` (extend existing test group)

The configure hook already publishes the config stub and registers the provider. This task (a) adds the publish step for the new `xrpc_handler.stub` so consumers get a ready-to-edit `app/exceptions/xrpc_handler.ts` at install time, and (b) adds the `useAsyncLocalStorage` verification step required by the spec's Prerequisites section.

**Steps:**

- [ ] **Step 1: Update `stubs/config.stub`**

Replace its contents with:

```
{{{
  exports({ to: app.configPath('atproto_xrpc.ts') })
}}}
import { defineConfig } from '@thisismissem/adonisjs-atproto-xrpc'
import env from '#start/env'

export default defineConfig({
  serviceDid: env.get('ATPROTO_SERVICE_DID'),
})
```

- [ ] **Step 1b: Create `stubs/app/exceptions/xrpc_handler.stub`**

```
{{{
  exports({ to: app.makePath('app/exceptions/xrpc_handler.ts') })
}}}
import { ExceptionHandler } from '@thisismissem/adonisjs-atproto-xrpc'
import type { XrpcContext, XrpcLexicon, XrpcError } from '@thisismissem/adonisjs-atproto-xrpc'

/**
 * XRPC exception handler. The base class ships sensible defaults:
 *
 *   - `report()`     — no-op (no observability integration assumed). Add
 *                      your Sentry / structured logging call here.
 *   - `handle()`     — sanitizes unexpected errors to `InternalServerError`
 *                      in production so internal messages / stack traces
 *                      don't leak to clients; preserves the cause in dev.
 *   - `shouldReport()` — returns true for every error; override to suppress.
 *
 * Both `report` and `handle` here just delegate to `super` — modify their
 * bodies to add custom behavior.
 */
export default class XrpcExceptionHandler extends ExceptionHandler {
  async report(error: unknown, ctx: XrpcContext<XrpcLexicon> | null) {
    return super.report(error, ctx)
  }

  async handle(error: unknown, ctx: XrpcContext<XrpcLexicon> | null): Promise<XrpcError> {
    return super.handle(error, ctx)
  }
}
```

The thin-delegation shape matches Adonis's `app/exceptions/handler.ts` convention — the stub is an extension point, not pre-filled custom logic.

- [ ] **Step 2: Update `configure.ts`**

Replace its contents with:

```ts
/*
|--------------------------------------------------------------------------
| Configure hook
|--------------------------------------------------------------------------
*/

import { readFile, writeFile } from 'node:fs/promises'
import type Configure from '@adonisjs/core/commands/configure'
import { stubsRoot } from './stubs/main.ts'

export async function configure(command: Configure) {
  const packageName = '@thisismissem/adonisjs-atproto-xrpc'

  const codemods = await command.createCodemods()

  await codemods.makeUsingStub(stubsRoot, 'config.stub', {})
  await codemods.makeUsingStub(stubsRoot, 'app/exceptions/xrpc_handler.stub', {})

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider(`${packageName}/provider`)
  })

  // The package's HTTP dispatch path reads HttpContext via Adonis's
  // per-request ALS — see the spec's Prerequisites section. Without the
  // flag, HTTP-triggered XRPC requests cannot reliably reach the
  // triggering HttpContext from inside atcute's router internals.
  await ensureUseAsyncLocalStorage(command)

  const instructions = command.ui.instructions()
  instructions.heading('AT Protocol XRPC setup!')
  instructions.add("Set the ATPROTO_SERVICE_DID env var to this service's DID before booting.")
  instructions.add(
    'Register the XRPC error handler in start/kernel.ts:\n' +
      "  import xrpc from '@thisismissem/adonisjs-atproto-xrpc/services/xrpc'\n" +
      "  xrpc.errorHandler(() => import('#exceptions/xrpc_handler'))"
  )
  instructions.render()
}

async function ensureUseAsyncLocalStorage(command: Configure) {
  const configPath = command.app.makePath('config/app.ts')
  const contents = await readFile(configPath, 'utf-8').catch(() => null)
  if (contents === null) return // app does not yet have config/app.ts; nothing to do

  if (/useAsyncLocalStorage\s*:\s*true/.test(contents)) return

  const enable = await command.prompt.confirm(
    'useAsyncLocalStorage is not enabled — enable it now? (required)'
  )
  if (!enable) {
    command.logger.warning(
      'Skipping useAsyncLocalStorage enablement. XRPC HTTP dispatch will fail until you set it manually.'
    )
    return
  }

  // Append `useAsyncLocalStorage: true` to the http config block. If the
  // block already exists we insert into it; if not we add a minimal block.
  const updated = /export\s+const\s+http\s*=\s*defineConfig\(\{/.test(contents)
    ? contents.replace(
        /export\s+const\s+http\s*=\s*defineConfig\(\{/,
        'export const http = defineConfig({\n  useAsyncLocalStorage: true,'
      )
    : contents + `\n\nexport const http = defineConfig({\n  useAsyncLocalStorage: true,\n})\n`
  await writeFile(configPath, updated)
}
```

- [ ] **Step 3: Write tests for useAsyncLocalStorage verification**

Append to `tests/configure.spec.ts` inside the existing `test.group('Configure', ...)`:

```ts
test('verifies useAsyncLocalStorage is enabled in config/app.ts', async ({ fs, assert }) => {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .create(BASE_URL, {
      importer: (filePath) => {
        if (filePath.startsWith('./') || filePath.startsWith('../')) {
          return import(new URL(filePath, BASE_URL).href)
        }
        return import(filePath)
      },
    })

  await fs.create('.env', '')
  await fs.createJson('tsconfig.json', {})
  await fs.create('start/env.ts', `export default Env.create(new URL('./'), {})`)
  await fs.create(
    'start/kernel.ts',
    `router.use([])
export const { middleware } = router.named({
})`
  )
  await fs.create('adonisrc.ts', `export default defineConfig({})`)
  // Note: NO useAsyncLocalStorage flag — we expect configure to prompt or note this.
  await fs.create('config/app.ts', `export const http = defineConfig({})`)

  const app = ignitor.createApp('web')
  await app.init()
  await app.boot()

  const ace = await app.container.make('ace')
  ace.prompt.trap(INSTALL_PROMPT).reject()
  // The new prompt — when useAsyncLocalStorage is missing, configure should
  // surface it. The test accepts (chooses "yes, enable it") so the file gets
  // rewritten.
  ace.prompt.trap('useAsyncLocalStorage is not enabled — enable it now? (required)').accept()

  const command = await ace.create(Configure, ['../../index.js'])
  await command['exec']()

  await assert.fileContains('config/app.ts', 'useAsyncLocalStorage')
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm quick:test --files tests/configure.spec.ts`
Expected: PASS — both the original test and the new flag-verification test.

- [ ] **Step 5: Commit**

```bash
git add configure.ts stubs/config.stub stubs/app/exceptions/xrpc_handler.stub tests/configure.spec.ts
git commit -m "feat(xrpc): configure() publishes handler stub, verifies useAsyncLocalStorage, seeds serviceDid"
```

---

## Task 6: Route declaration builders in `src/router.ts`

**Files:**

- Create: `src/router.ts`
- Create: `tests/router.spec.ts`

This task delivers `XrpcRouter` + `XrpcRoute` + `XrpcRouteGroup`. **No auth.** The router builder accumulates a routes registry; declaration methods throw after commit; nested groups throw.

Handler registration is **normalized eagerly** into a discriminated `NormalizedHandler` shape (`{ kind: 'function' } | { kind: 'controller' }`). The controller branch goes through `@adonisjs/fold`'s `moduleCaller` (for eager class refs) and `moduleImporter` (for lazy imports), matching the resolution path Adonis's own `@adonisjs/http-server` uses in `src/router/route.ts#resolveRouteHandle`. This means: (a) inline functions stay on the cheap call path (`fn(ctx)` — no resolver indirection); (b) controller refs get container-DI on both constructor and method (`resolver.call(instance, method, args)`); (c) lazy imports get import caching + HMR awareness for free; (d) class-vs-lazy-import is detected via `is.class(controller)` (the same primitive Adonis uses), not a hand-rolled `prototype` heuristic. Plan 03's dispatch executor consumes the normalized shape with a one-line discriminator branch — it doesn't do its own handler resolution.

**Steps:**

- [ ] **Step 1: Implement `src/router.ts`**

Create `src/router.ts`:

```ts
import Macroable from '@poppinss/macroable'
import { moduleCaller, moduleImporter } from '@adonisjs/core/container'
import type { ContainerResolver } from '@adonisjs/core/types/container'
import { RuntimeException } from '@adonisjs/core/exceptions'
import type { ApplicationService } from '@adonisjs/core/types'
import type { Constructor, LazyImport } from '@poppinss/utils/types'
import type {
  XrpcLexicon,
  XrpcProcedureLexicon,
  XrpcQueryLexicon,
  XrpcSubscriptionLexicon,
} from './types.js'

/**
 * The shape passed by consumers to `procedure / query / subscription`. Either
 * an inline function or a `[Controller | LazyImport<Controller>, methodName?]`
 * tuple. Mirrors `@adonisjs/http-server`'s `RouteFn | [..., method?]` union in
 * `src/router/route.ts`.
 */
export type XrpcHandlerInput =
  | ((ctx: any) => any)
  | [LazyImport<Constructor<any>> | Constructor<any>, string?]

/**
 * Stored form after `#register` normalizes the input. Plan 03's dispatch
 * executor branches on `kind`:
 *
 * - `function` — inline handler. Executor calls `fn(ctx)` directly.
 * - `controller` — controller-reference (eager class or lazy import). Executor
 *   calls `handle(resolver, ctx)`; `@adonisjs/fold`'s `moduleCaller` /
 *   `moduleImporter` produces the `handle` closure with method-level DI,
 *   import caching, and HMR awareness baked in.
 *
 * The `name` on the controller branch comes from fold's `.toHandleMethod()`
 * (`'ClassName.method'` for eager refs; the import function's `.name` for
 * lazy refs). The route's NSID is the authoritative identifier — this `name`
 * is a secondary "what's serving this NSID" label used by Plan 06's
 * `list:xrpc:routes` and Plan 04's error-reporter context.
 */
export type NormalizedHandler =
  | { kind: 'function'; fn: (ctx: any) => any }
  | {
      kind: 'controller'
      name: string
      handle: (resolver: ContainerResolver<any>, ctx: any) => Promise<unknown>
    }

/**
 * Per-route registry entry. `handler` is the normalized form — `#register`
 * runs `#normalizeHandler` on every input before storing. The shared dispatch
 * executor (Plan 03) reads this map by NSID at request time.
 *
 * Auth state is intentionally absent in this plan — Plan 05 attaches an
 * `auth: RouteAuthDecl` field via declaration merging on RouteInfo (and
 * the matching `.serviceAuth(...)` builder methods via XrpcRoute.macro
 * and XrpcRouteGroup.macro).
 */
export interface RouteInfo {
  lexicon: XrpcLexicon
  handler: NormalizedHandler
}

/**
 * Per-route chainable builder. Returned from `router.xrpc.procedure / query
 * / subscription`. Extends Macroable so plugin packages (and Plan 02's auth)
 * can attach declarative methods at runtime — e.g.
 * `XrpcRoute.macro('serviceAuth', fn)`.
 *
 * @internal — only XrpcRouter constructs XrpcRoute instances.
 */
export class XrpcRoute extends Macroable {
  constructor(public nsid: string) {
    super()
  }
}

/**
 * Chainable builder returned from `router.xrpc.group(callback)`. Carries
 * the list of routes registered inside the callback so a future
 * `.serviceAuth(...)` macro (Plan 02) can fan flags across them.
 *
 * @internal — only XrpcRouter constructs XrpcRouteGroup instances.
 */
export class XrpcRouteGroup extends Macroable {
  constructor(public routes: XrpcRoute[]) {
    super()
  }
}

// Distinguish eager class constructor from lazy-import arrow. ES6 class
// declarations stringify as `class …`; arrows / plain functions don't.
// This is what @sindresorhus/is.class() does internally — inlined here to
// avoid pulling that dep in for one check (we're Node 24+ ESM, so legacy
// transpiled-class detection isn't needed).
const isClassRegex = /^class\s/
const isClass = (value) => {
  return typeof value === 'function' && isClassRegex.test(Function.prototype.toString.call(value))
}

/**
 * Build-time route registry. Macroable so future plugin integrations can
 * attach declarative methods on the router itself (e.g. a tracing plugin
 * registering `router.xrpc.tracing(...)`). Mirrors Adonis's own
 * Router/Route/RouteGroup macroable structure.
 */
export class XrpcRouter extends Macroable {
  #operations = new Map<string, RouteInfo>()
  #routesByNsid = new Map<string, XrpcRoute>()
  #committed = false
  #groupContext: { routes: XrpcRoute[] }[] = []

  constructor(public app: ApplicationService) {
    super()
  }

  procedure<L extends XrpcProcedureLexicon>(lexicon: L, handler: XrpcHandlerInput): XrpcRoute {
    return this.#register(lexicon, handler)
  }

  query<L extends XrpcQueryLexicon>(lexicon: L, handler: XrpcHandlerInput): XrpcRoute {
    return this.#register(lexicon, handler)
  }

  subscription<L extends XrpcSubscriptionLexicon>(
    lexicon: L,
    handler: XrpcHandlerInput
  ): XrpcRoute {
    return this.#register(lexicon, handler)
  }

  /**
   * Declares a route group. Nested groups are not supported in v1; the
   * stack length invariant is enforced explicitly so future use-cases
   * (e.g. prefixed sub-groups) can lift the restriction without breaking
   * the existing semantic.
   */
  group(callback: () => void): XrpcRouteGroup {
    if (this.#committed) {
      throw new RuntimeException('Cannot declare XRPC groups after commit')
    }
    if (this.#groupContext.length > 0) {
      throw new RuntimeException('Nested xrpc.group() is not supported in v1')
    }

    const ctx = { routes: [] as XrpcRoute[] }
    this.#groupContext.push(ctx)
    try {
      callback()
    } finally {
      this.#groupContext.pop()
    }
    return new XrpcRouteGroup(ctx.routes)
  }

  #register(lexicon: XrpcLexicon, handler: XrpcHandlerInput): XrpcRoute {
    if (this.#committed) {
      throw new RuntimeException('Cannot register XRPC routes after commit')
    }
    if (this.#operations.has(lexicon.id)) {
      throw new RuntimeException(`XRPC route already registered for NSID "${lexicon.id}"`)
    }
    const route = new XrpcRoute(lexicon.id)
    this.#operations.set(lexicon.id, { lexicon, handler: this.#normalizeHandler(handler) })
    this.#routesByNsid.set(lexicon.id, route)
    this.#groupContext.at(-1)?.routes.push(route)
    return route
  }

  /**
   * Normalizes a user-facing handler input into the stored `NormalizedHandler`
   * shape. Mirrors `@adonisjs/http-server`'s `route.ts#resolveRouteHandle`:
   * eager class refs go through `moduleCaller` (constructs via the container
   * + invokes the method with method-level DI); lazy imports go through
   * `moduleImporter` (caches the resolved module, re-imports under HMR).
   * Inline functions bypass both — they stay on the cheap call path.
   */
  #normalizeHandler(handler: XrpcHandlerInput): NormalizedHandler {
    if (typeof handler === 'function') {
      return { kind: 'function', fn: handler }
    }
    if (!Array.isArray(handler)) {
      throw new RuntimeException(
        'XRPC handler must be an inline function or a [Controller | LazyImport, method?] tuple'
      )
    }
    const [refOrLazy, method = 'handle'] = handler

    const m = isClass(refOrLazy)
      ? moduleCaller(refOrLazy as Constructor<any>, method).toHandleMethod()
      : moduleImporter(
          refOrLazy as () => Promise<{ default: Constructor<any> }>,
          method
        ).toHandleMethod()
    return { kind: 'controller', name: m.name, handle: m.handle as NormalizedHandler['handle'] }
  }

  /**
   * True once `commit()` has run. Reads from this property are how the
   * dispatch layer (Plan 03) detects whether to install routes.
   */
  get committed(): boolean {
    return this.#committed
  }

  /**
   * Read-only view of the registered routes, keyed by NSID. Returned as a
   * `ReadonlyMap` (not a plain object) so user-controlled NSID lookups in
   * downstream code (Plan 03's executor) can't accidentally hit
   * `Object.prototype` members like `'__proto__'` / `'constructor'` /
   * `'toString'` — `Map.get('__proto__')` returns `undefined` cleanly, unlike
   * `obj['__proto__']` which returns the prototype. The internal `#operations`
   * is returned directly (no defensive copy) — `ReadonlyMap` is type-only,
   * but consumers are internal and the type signals intent.
   */
  get operations(): ReadonlyMap<string, RouteInfo> {
    return this.#operations
  }

  /** Looks up an XrpcRoute by NSID — used by Plan 02's group fan-out. */
  routeFor(nsid: string): XrpcRoute | undefined {
    return this.#routesByNsid.get(nsid)
  }

  /**
   * Transitions the builder to its frozen state. Idempotent — safe to call
   * defensively from anywhere. After commit, declaration methods throw
   * `RuntimeException`.
   */
  commit(): void {
    if (this.#committed) return
    this.#committed = true
  }
}
```

- [ ] **Step 2: Write tests for the router**

Create `tests/router.spec.ts`:

```ts
import { test } from '@japa/runner'
import { ApplicationService } from '@adonisjs/core/types'
import { XrpcRouter, XrpcRoute, XrpcRouteGroup } from '../src/router.js'

// Minimal application stub — XrpcRouter only stashes the reference for now.
function fakeApp(): ApplicationService {
  return {} as ApplicationService
}

// Minimal lexicon stubs. Real lexicons come from @atcute-codegened output; the
// builder only inspects `id` and `type`, so a structural stub suffices.
const procedureLex = { id: 'com.example.test.proc', type: 'xrpc_procedure' } as any
const queryLex = { id: 'com.example.test.query', type: 'xrpc_query' } as any
const subscriptionLex = { id: 'com.example.test.sub', type: 'xrpc_subscription' } as any

test.group('XrpcRouter — declarations', () => {
  test('procedure / query / subscription register routes keyed by NSID', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    r.procedure(procedureLex, async () => ({}))
    r.query(queryLex, async () => ({}))
    r.subscription(subscriptionLex, async function* () {})
    assert.equal(r.operations.get('com.example.test.proc')?.lexicon, procedureLex)
    assert.equal(r.operations.get('com.example.test.query')?.lexicon, queryLex)
    assert.equal(r.operations.get('com.example.test.sub')?.lexicon, subscriptionLex)
  })

  test('operations is a ReadonlyMap (not a plain object) — protects against prototype-name lookups', ({
    assert,
  }) => {
    const r = new XrpcRouter(fakeApp())
    r.procedure(procedureLex, async () => ({}))
    assert.instanceOf(r.operations, Map)
    // The point of the Map is that user-controlled NSID lookups can't hit
    // Object.prototype members. `Map.get('__proto__')` returns undefined
    // cleanly, unlike `obj['__proto__']` which would return the prototype.
    assert.isUndefined(r.operations.get('__proto__'))
    assert.isUndefined(r.operations.get('constructor'))
    assert.isUndefined(r.operations.get('toString'))
  })

  test('procedure() returns an XrpcRoute instance', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    const route = r.procedure(procedureLex, async () => ({}))
    assert.instanceOf(route, XrpcRoute)
  })

  test('inline function handler normalizes to { kind: "function" }', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    const fn = async () => ({ ok: true })
    r.procedure(procedureLex, fn)
    const info = r.operations.get('com.example.test.proc')!
    assert.equal(info.handler.kind, 'function')
    assert.equal((info.handler as any).fn, fn, 'inline fn stored verbatim under .fn')
  })

  test('eager controller-class reference normalizes to { kind: "controller" } with a bound name', ({
    assert,
  }) => {
    const r = new XrpcRouter(fakeApp())
    class FakeController {
      async create() {}
    }
    const route = r.procedure(procedureLex, [FakeController, 'create' as any])
    assert.instanceOf(route, XrpcRoute)
    const info = r.operations.get('com.example.test.proc')!
    assert.equal(info.handler.kind, 'controller')
    assert.isFunction((info.handler as any).handle, 'normalized controller handler exposes .handle')
    assert.equal(
      (info.handler as any).name,
      'FakeController.create',
      'moduleCaller sets .name to ClassName.method'
    )
  })

  test('lazy-import controller reference normalizes to { kind: "controller" }', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    class FakeController {
      async create() {}
    }
    const lazy = async () => ({ default: FakeController })
    r.procedure(queryLex, [lazy as any, 'create' as any])
    const info = r.operations.get('com.example.test.query')!
    assert.equal(info.handler.kind, 'controller')
    assert.isFunction((info.handler as any).handle)
    // moduleImporter sets .name from the import function's `.name` — anonymous
    // arrow gives an empty string; what matters is .handle is callable.
  })

  test('non-function / non-array handler input is rejected at register time', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    assert.throws(
      () => r.procedure(procedureLex, 'not-a-handler' as any),
      /must be an inline function or a \[Controller \| LazyImport, method\?\] tuple/
    )
  })
})

test.group('XrpcRouter — group', () => {
  test('group() returns an XrpcRouteGroup wrapping the inner routes', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    const group = r.group(() => {
      r.procedure(procedureLex, async () => ({}))
      r.query(queryLex, async () => ({}))
    })
    assert.instanceOf(group, XrpcRouteGroup)
  })

  test('group() runs its callback exactly once', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    let calls = 0
    r.group(() => {
      calls++
    })
    assert.equal(calls, 1)
  })

  test('nested group() throws RuntimeException', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    assert.throws(
      () =>
        r.group(() => {
          r.group(() => {})
        }),
      /Nested xrpc\.group\(\) is not supported/
    )
  })
})

test.group('XrpcRouter — commit', () => {
  test('commit() freezes the router; subsequent registrations throw', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    r.procedure(procedureLex, async () => ({}))
    assert.isFalse(r.committed)
    r.commit()
    assert.isTrue(r.committed)
    assert.throws(
      () => r.procedure(queryLex as any, async () => ({})),
      /Cannot register XRPC routes after commit/
    )
    assert.throws(() => r.group(() => {}), /Cannot declare XRPC groups after commit/)
  })

  test('commit() is idempotent', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    r.commit()
    r.commit() // no throw
    assert.isTrue(r.committed)
  })
})

test.group('XrpcRouter — macroable', () => {
  test('XrpcRouter / XrpcRoute / XrpcRouteGroup expose .macro()', ({ assert }) => {
    // All three extend Macroable; .macro is a static method on Macroable subclasses.
    assert.isFunction((XrpcRouter as any).macro)
    assert.isFunction((XrpcRoute as any).macro)
    assert.isFunction((XrpcRouteGroup as any).macro)
  })

  test('a macro attached to XrpcRoute is callable on instances', ({ assert }) => {
    ;(XrpcRoute as any).macro('mark', function (this: XrpcRoute) {
      ;(this as any)._marked = true
      return this
    })
    const r = new XrpcRouter(fakeApp())
    const route = r.procedure(procedureLex, async () => ({}))
    const out = (route as any).mark()
    assert.equal((out as any)._marked, true)
    assert.equal(out, route, 'macro returns the route for chaining')
    delete (XrpcRoute as any).macros.mark
  })
})
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm quick:test --files tests/router.spec.ts`
Expected: PASS — all groups.

- [ ] **Step 4: Append the Adonis `Router` augmentation to `src/types.ts`**

Append the following block to `src/types.ts` (after the existing primitive exports — not in Task 2's snippet because `XrpcRouter` didn't exist yet at that point in the plan).

```ts
// --- Adonis Router augmentation ----------------------------------------
//
// Declared here (rather than in providers/provider.ts) so the augmentation
// is visible everywhere `src/types.ts` is — including test files and
// consumer code that import package symbols transitively — without forcing
// each `router.xrpc` consumer to add a side-effect import of the provider
// just to satisfy the typechecker. The runtime install happens in the
// provider's `boot()` (see Plan 03); this declaration is type-only.
import type { XrpcRouter } from './router.js'

declare module '@adonisjs/core/http' {
  interface Router {
    xrpc: XrpcRouter
  }
}
```

Then run `pnpm typecheck` and confirm zero errors. The type-only circular reference (`types.ts` ↔ `router.ts`) is fine because both sides use `import type` for their cross-references — TypeScript resolves these at type-check time only, no runtime cycle.

- [ ] **Step 5: Commit**

```bash
git add src/router.ts src/types.ts tests/router.spec.ts
git commit -m "feat(xrpc): add XrpcRouter / XrpcRoute / XrpcRouteGroup + Router.xrpc type augmentation"
```

---

## Task 7: Web ↔ Adonis request/response conversion in `src/utils.ts`

**Files:**

- Create: `src/utils.ts`
- Create: `tests/utils.spec.ts`

Two small bridge functions that map between Adonis's `HttpRequest` / `HttpResponse` (wrapping Node's `IncomingMessage` / `ServerResponse`) and the Web Fetch `Request` / `Response` shapes atcute speaks. Same shape as the helpers in `fedify-dev/adonisjs`'s middleware (`src/middleware/fedify.ts`), promoted from private methods to package-level utilities since Plan 03's dispatch middleware will need them on real traffic, and Plan 01's factory + context tests need them to keep test fixtures consistent.

Streaming both directions (`Readable.toWeb` and `Readable.fromWeb`) avoids buffering bodies in memory — XRPC procedures can carry image blobs and other large payloads.

**Steps:**

- [ ] **Step 1: Implement `src/utils.ts`**

Create `src/utils.ts`:

```ts
/*
|--------------------------------------------------------------------------
| Web Fetch ↔ Adonis HTTP conversion utilities
|--------------------------------------------------------------------------
|
| Bridge between Adonis's HttpRequest/HttpResponse (wrapping Node's
| IncomingMessage/ServerResponse) and the Web Fetch Request/Response
| shapes that atcute's xrpc-server speaks.
|
| Same approach as `fedify-dev/adonisjs`'s middleware: stream bodies in
| both directions via `Readable.toWeb` / `Readable.fromWeb` to avoid
| buffering large payloads.
*/

import { Readable } from 'node:stream'
import type {
  Request as AdonisHttpRequest,
  Response as AdonisHttpResponse,
} from '@adonisjs/core/http'

/**
 * Converts an Adonis HttpRequest into a Web Fetch Request.
 *
 * @param req - The Adonis request to convert.
 * @param baseUrl - Optional base URL used to resolve `req.completeUrl(true)`
 *   when the request lacks a Host header (e.g. tests using
 *   HttpContextFactory's default request). Real traffic supplies a Host
 *   header so this argument is unnecessary in production.
 */
export function adonisRequestToWebRequest(req: AdonisHttpRequest, baseUrl?: string | URL): Request {
  const urlString = req.completeUrl(true)
  const url = baseUrl ? new URL(urlString, baseUrl) : new URL(urlString)

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers())) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v)
    } else if (typeof value === 'string') {
      headers.append(key, value)
    }
  }

  const method = req.method() ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD'

  return new Request(url, {
    method,
    headers,
    // `duplex: 'half'` is required by the Fetch spec when streaming a
    // ReadableStream body. Cast to RequestInit because TS lib types lag
    // behind the runtime support.
    ...(hasBody && { duplex: 'half', body: Readable.toWeb(req.request) }),
  } as RequestInit)
}

/**
 * Writes a Web Fetch Response back into an Adonis HttpResponse: copies
 * status + headers, then streams the body (if any) via
 * `res.stream(Readable.fromWeb(body))`.
 */
export function writeWebResponseToAdonisResponse(
  response: Response,
  res: AdonisHttpResponse
): void {
  res.status(response.status)
  response.headers.forEach((value, key) => {
    res.header(key, value)
  })
  if (response.body !== null) {
    res.stream(Readable.fromWeb(response.body))
  }
}
```

- [ ] **Step 2: Write tests for the conversion utilities**

Create `tests/utils.spec.ts`:

```ts
import { test } from '@japa/runner'
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import { adonisRequestToWebRequest, writeWebResponseToAdonisResponse } from '../src/utils.js'

test.group('adonisRequestToWebRequest', () => {
  test('preserves URL and method', ({ assert }) => {
    const ctx = new HttpContextFactory().create()
    const req = adonisRequestToWebRequest(ctx.request, 'http://localhost')
    assert.instanceOf(req, Request)
    assert.equal(req.method, ctx.request.method() ?? 'GET')
  })

  test('forwards headers (string and array values)', ({ assert }) => {
    const ctx = new HttpContextFactory().create()
    // HttpContextFactory's default request has no real headers; we patch
    // headers() to exercise both shapes.
    const originalHeaders = ctx.request.headers
    ctx.request.headers = () =>
      ({
        'authorization': 'Bearer token',
        'x-multi': ['a', 'b'],
      }) as any
    try {
      const req = adonisRequestToWebRequest(ctx.request, 'http://localhost')
      assert.equal(req.headers.get('authorization'), 'Bearer token')
      assert.equal(req.headers.get('x-multi'), 'a, b')
    } finally {
      ctx.request.headers = originalHeaders
    }
  })

  test('GET / HEAD requests carry no body', ({ assert }) => {
    const ctx = new HttpContextFactory().create()
    ctx.request.method = () => 'GET'
    const req = adonisRequestToWebRequest(ctx.request, 'http://localhost')
    assert.isNull(req.body)
  })
})

test.group('writeWebResponseToAdonisResponse', () => {
  test('forwards status and headers', ({ assert }) => {
    const ctx = new HttpContextFactory().create()
    const web = new Response('hello', {
      status: 201,
      headers: { 'content-type': 'text/plain', 'etag': 'xyz' },
    })
    writeWebResponseToAdonisResponse(web, ctx.response)
    assert.equal(ctx.response.getStatus(), 201)
    assert.equal(ctx.response.getHeader('content-type'), 'text/plain')
    assert.equal(ctx.response.getHeader('etag'), 'xyz')
  })

  test('null-body responses do not call stream()', ({ assert }) => {
    const ctx = new HttpContextFactory().create()
    let streamed = false
    const originalStream = ctx.response.stream
    ctx.response.stream = () => {
      streamed = true
      return ctx.response
    }
    try {
      const web = new Response(null, { status: 204 })
      writeWebResponseToAdonisResponse(web, ctx.response)
      assert.isFalse(streamed)
    } finally {
      ctx.response.stream = originalStream
    }
  })
})
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm quick:test --files tests/utils.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 4: Commit**

```bash
git add src/utils.ts tests/utils.spec.ts
git commit -m "feat(xrpc): add Web ↔ Adonis request/response conversion utilities"
```

---

## Task 8: Runtime context types in `src/context.ts`

**Files:**

- Create: `src/context.ts`
- Create: `tests/context.spec.ts`

Delivers `XrpcContext`, `XrpcResponse`, `XrpcStream` (all Macroable). `XrpcContext.get()` / `XrpcContext.getOrFail()` read from a package-owned `AsyncLocalStorage` (non-throwing and throwing variants — same shape as `HttpContext.get()` / `HttpContext.getOrFail()`). **No `.auth` field** — a future auth-spec attaches it via declaration merging + macro.

The constructor takes materialized per-request primitives (`logger`, `containerResolver`, `requestId`, `request: HttpRequest`) rather than a full `HttpContext` — the package doesn't keep an Adonis `HttpContext` reference around because the WS-subscription path has no such object to expose anyway (see the design spec's "HTTP-context asymmetry" section). The dispatch boundary (Plan 03's middleware + WS upgrade listener) materializes these via `fromHttpContext(httpCtx)` or directly from the upgrade `IncomingMessage`, then threads them as a `RequestContext` into the executor, which forwards them to the `XrpcContext` constructor.

**Steps:**

- [ ] **Step 1: Implement `src/context.ts`**

Create `src/context.ts`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks'
import Macroable from '@poppinss/macroable'
import { RuntimeException } from '@adonisjs/core/exceptions'
import type { HttpRequest, Logger } from '@adonisjs/core/http'
import type { ContainerResolver } from '@adonisjs/core/types/container'
import type {
  InferInput,
  InferOutput,
  InferParams,
  XrpcLexicon,
  XrpcMessage,
  XrpcMessagePayload,
  XrpcMessageRef,
  XrpcSubscriptionLexicon,
} from './types.js'

/**
 * Output channel for procedure / query handlers. Buffers response state
 * locally (status / headers / body / redirect) — the dispatch executor
 * (Plan 03) reads `.state` after the handler resolves and constructs the
 * wire `Response` (atcute's router checks `output instanceof Response` and
 * silently drops non-Response returns, so the executor MUST construct one).
 *
 * Macroable so plugin packages can attach declarative response methods.
 *
 * For subscriptions, this class is not used — `XrpcStream` lives in the same
 * `ctx.response` slot for that path.
 *
 * @internal — instances constructed by `XrpcContext`'s constructor (which
 * branches on `lexicon.type`).
 */
export class XrpcResponse<L extends XrpcLexicon> extends Macroable {
  /**
   * Accumulated state from chainable setter calls. Read by the dispatch
   * executor after the handler resolves. `bodySet` is the discriminator
   * (rather than `body !== undefined`) because a handler can legitimately
   * call `.json(null)` for null-output lexicons — "explicitly set to null"
   * must differ from "never called".
   */
  readonly state: {
    status?: number
    headers: Headers
    body?: InferOutput<L>
    bodySet: boolean
    redirect?: { url: string; status: 301 | 302 | 303 | 307 | 308 }
  }

  constructor() {
    super()
    this.state = { headers: new Headers(), bodySet: false }
  }

  status(code: number): this {
    this.state.status = code
    return this
  }

  header(name: string, value: string): this {
    this.state.headers.set(name, value)
    return this
  }

  json(value: InferOutput<L>): this {
    this.state.body = value
    this.state.bodySet = true
    return this
  }

  redirect(url: string, status: 301 | 302 | 303 | 307 | 308 = 302): this {
    this.state.redirect = { url, status }
    return this
  }
}

/**
 * Output channel for subscription handlers. The handler yields the values
 * returned from `message(ref, payload)`; the dispatch executor (Plan 03)
 * pipes each one through the serializer before atcute frames it on the wire.
 *
 * @internal — instances constructed by dispatch.
 */
export class XrpcStream<L extends XrpcSubscriptionLexicon> extends Macroable {
  constructor(
    private lexicon: L,
    public readonly signal: AbortSignal
  ) {
    super()
  }

  get aborted(): boolean {
    return this.signal.aborted
  }

  /**
   * Builds a typed message object with `$type` derived from the lexicon's
   * NSID plus the ref name (e.g. `com.example.foo#labels`). The atcute
   * subscription codec uses `$type` as the wire-format discriminator.
   *
   * `R` is narrowed to the lexicon's actual declared message refs via
   * `XrpcMessageRef<L>` — passing an unknown ref name is a compile error.
   * `payload` is narrowed to the matching variant's shape via
   * `XrpcMessagePayload<L, R>`.
   */
  message<R extends XrpcMessageRef<L>>(ref: R, payload: XrpcMessagePayload<L, R>): XrpcMessage<L> {
    return {
      $type: `${this.lexicon.id}${ref}`,
      ...payload,
    } as unknown as XrpcMessage<L>
  }
}

/**
 * Constructor params for XrpcContext. Materialized at the dispatch boundary
 * — see Plan 03's `fromHttpContext()` (HTTP path) and `#installWebSocketHandler`
 * (WS path) for the two sources. Kept as a single object for forward-compat
 * — adding new fields stays non-breaking.
 */
export interface XrpcContextParams<L extends XrpcLexicon> {
  lexicon: L
  request: HttpRequest // Adonis HttpRequest — .validateUsing, .header, .input, etc.
  input: L extends XrpcSubscriptionLexicon ? undefined : InferInput<L>
  params: InferParams<L>
  signal: AbortSignal
  logger: Logger
  containerResolver: ContainerResolver
  requestId: string
}

/**
 * Per-request XRPC context. Constructed by the dispatch executor (Plan 03)
 * for both HTTP-triggered (procedure / query) and subscription paths. The
 * static `als` slot plus the `get()` / `getOrFail()` accessors let downstream
 * code reach the current context without explicit threading.
 *
 * Macroable so that future extensions (e.g. an auth field attached via
 * declaration merging + getter macro) can graft onto the class without
 * changing its constructor.
 *
 * Notably absent: no `httpContext` getter / no underlying HttpContext field.
 * The WS-subscription path has no Adonis HttpContext to expose, so the design
 * spec mandates exposing the request-scoped primitives directly (`logger`,
 * `containerResolver`, `requestId`, `request: HttpRequest`) rather than
 * routing them through a sometimes-synthetic HttpContext. See the spec's
 * "HTTP-context asymmetry" section for the rationale.
 */
export class XrpcContext<L extends XrpcLexicon> extends Macroable {
  static readonly als = new AsyncLocalStorage<XrpcContext<XrpcLexicon>>()

  /**
   * Returns the active XrpcContext from the package's own ALS, or
   * `undefined` if called outside an XRPC handler scope. Mirrors
   * `HttpContext.get()` on the Adonis side — use when the caller can
   * reasonably proceed without an XRPC context (e.g. a shared logging /
   * observability helper that adds XRPC tags when available and skips them
   * when not).
   */
  static get(): XrpcContext<XrpcLexicon> | undefined {
    return XrpcContext.als.getStore()
  }

  /**
   * Returns the active XrpcContext from the package's own ALS, or throws
   * `RuntimeException` if called outside an XRPC handler scope. Use this
   * inside XRPC handlers and any downstream code that requires the
   * context — `HttpContext.getOrFail()` won't work on the WS-subscription
   * path (there's no Adonis HttpContext), and prefer this even on the HTTP
   * path so the same accessor works in both. See the spec's "HTTP-context
   * asymmetry" section for the rationale.
   */
  static getOrFail(): XrpcContext<XrpcLexicon> {
    const ctx = XrpcContext.als.getStore()
    if (!ctx) {
      throw new RuntimeException(
        'XrpcContext is not available — called outside an XRPC handler scope'
      )
    }
    return ctx
  }

  readonly request: HttpRequest
  readonly lexicon: L
  readonly input: L extends XrpcSubscriptionLexicon ? undefined : InferInput<L>
  readonly params: InferParams<L>
  readonly signal: AbortSignal
  readonly response: L extends XrpcSubscriptionLexicon ? XrpcStream<L> : XrpcResponse<L>

  // Mirrored from the dispatch-boundary `RequestContext`:
  readonly logger: Logger
  readonly containerResolver: ContainerResolver
  readonly requestId: string

  /** @internal — instances constructed by dispatch or XrpcContextFactory. */
  constructor(params: XrpcContextParams<L>) {
    super()
    this.lexicon = params.lexicon
    this.request = params.request
    this.input = params.input
    this.params = params.params
    this.signal = params.signal
    this.logger = params.logger
    this.containerResolver = params.containerResolver
    this.requestId = params.requestId

    // Single place that knows the lexicon-kind → response-kind mapping.
    // The executor doesn't need to construct these itself.
    this.response = (
      params.lexicon.type === 'xrpc_subscription'
        ? new XrpcStream(params.lexicon as L & XrpcSubscriptionLexicon, params.signal)
        : new XrpcResponse<L>()
    ) as XrpcContext<L>['response']
  }
}
```

- [ ] **Step 2: Write tests for context types**

Create `tests/context.spec.ts`:

```ts
import { test } from '@japa/runner'
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import { XrpcContext, XrpcResponse, XrpcStream } from '../src/context.js'

const procedureLex = { id: 'com.example.test.proc', type: 'xrpc_procedure' } as any
const subscriptionLex = { id: 'com.example.test.sub', type: 'xrpc_subscription' } as any

function makeContext(overrides: Partial<ConstructorParameters<typeof XrpcContext>[0]> = {}) {
  // HttpContextFactory gives us a real-shaped HttpRequest / Logger / resolver
  // without standing up an Adonis pipeline — same dependency the production
  // HTTP-path materialization uses via `fromHttpContext()`. Tests that need
  // to override individual primitives can do so via `merge()`.
  const httpCtx = new HttpContextFactory().create()
  const lexicon = (overrides.lexicon as any) ?? procedureLex
  return new XrpcContext({
    lexicon,
    request: httpCtx.request,
    input: undefined,
    params: {},
    signal: new AbortController().signal,
    logger: httpCtx.logger,
    containerResolver: httpCtx.containerResolver,
    requestId: httpCtx.request.id() ?? 'test-req-id',
    ...overrides,
  })
}

test.group('XrpcContext — construction', () => {
  test('exposes the materialized primitives directly', ({ assert }) => {
    const ctx = makeContext()
    assert.isObject(ctx.logger)
    assert.isObject(ctx.containerResolver)
    assert.isString(ctx.requestId)
    assert.isObject(ctx.request)
    assert.isFunction((ctx.request as any).header) // HttpRequest API surface
  })

  test('procedure-kind context exposes response as XrpcResponse', ({ assert }) => {
    const ctx = makeContext()
    assert.instanceOf(ctx.response, XrpcResponse)
  })

  test('subscription-kind context exposes response as XrpcStream', ({ assert }) => {
    const ctx = makeContext({ lexicon: subscriptionLex })
    assert.instanceOf(ctx.response, XrpcStream)
  })
})

test.group('XrpcContext.get / .getOrFail — ALS', () => {
  test('get() returns undefined outside any als.run scope', ({ assert }) => {
    assert.isUndefined(XrpcContext.get())
  })

  test('getOrFail() throws outside any als.run scope', ({ assert }) => {
    assert.throws(() => XrpcContext.getOrFail(), /XrpcContext is not available/)
  })

  test('get() and getOrFail() both return the active context inside an als.run scope', async ({
    assert,
  }) => {
    const ctx = makeContext()
    await XrpcContext.als.run(ctx, async () => {
      assert.equal(XrpcContext.get(), ctx)
      assert.equal(XrpcContext.getOrFail(), ctx)
      await new Promise((r) => setImmediate(r))
      // Async continuation inherits the store:
      assert.equal(XrpcContext.get(), ctx)
      assert.equal(XrpcContext.getOrFail(), ctx)
    })
  })

  test('nested als.run scopes shadow the outer context', async ({ assert }) => {
    const outer = makeContext()
    const inner = makeContext()
    await XrpcContext.als.run(outer, async () => {
      assert.equal(XrpcContext.getOrFail(), outer)
      await XrpcContext.als.run(inner, async () => {
        assert.equal(XrpcContext.getOrFail(), inner)
      })
      assert.equal(XrpcContext.getOrFail(), outer)
    })
  })
})

test.group('XrpcResponse — chainable setters', () => {
  test('status / header mutate internal state and return `this`', ({ assert }) => {
    const ctx = makeContext()
    const ret = ctx.response.status(201).header('etag', 'abc')
    assert.equal(ret, ctx.response, 'chain returns itself')
    assert.equal((ctx.response as XrpcResponse<any>).state.status, 201)
    assert.equal((ctx.response as XrpcResponse<any>).state.headers.get('etag'), 'abc')
  })

  test('json() buffers the body for the executor and flips bodySet', ({ assert }) => {
    const ctx = makeContext()
    ;(ctx.response as XrpcResponse<any>).json({ id: 'x' })
    const state = (ctx.response as XrpcResponse<any>).state
    assert.deepEqual(state.body, { id: 'x' })
    assert.isTrue(state.bodySet)
  })

  test('bodySet defaults to false when json() is never called', ({ assert }) => {
    const ctx = makeContext()
    ctx.response.status(204)
    const state = (ctx.response as XrpcResponse<any>).state
    assert.isFalse(state.bodySet)
    assert.isUndefined(state.body)
  })

  test('initial state has empty Headers and undefined status / body / redirect', ({ assert }) => {
    const ctx = makeContext()
    const state = (ctx.response as XrpcResponse<any>).state
    assert.isUndefined(state.status)
    assert.isUndefined(state.body)
    assert.isUndefined(state.redirect)
    assert.isFalse(state.bodySet)
    assert.instanceOf(state.headers, Headers)
    assert.equal([...state.headers].length, 0)
  })

  test('redirect() records url + status on state', ({ assert }) => {
    const ctx = makeContext()
    ctx.response.redirect('https://cdn.example/blob.bin', 302)
    const state = (ctx.response as XrpcResponse<any>).state
    assert.deepEqual(state.redirect, { url: 'https://cdn.example/blob.bin', status: 302 })
  })
})

test.group('XrpcStream — subscription helpers', () => {
  test('signal / aborted mirror the AbortController', ({ assert }) => {
    const ac = new AbortController()
    const ctx = makeContext({ lexicon: subscriptionLex, signal: ac.signal })
    const { response: stream } = ctx
    assert.instanceOf(stream, XrpcStream)
    assert.equal(stream.signal, ac.signal)
    assert.isFalse(stream.aborted)
    ac.abort()
    assert.isTrue(stream.aborted)
  })

  test('message() returns a payload with the $type discriminator derived from NSID + ref', ({
    assert,
  }) => {
    const ctx = makeContext({ lexicon: subscriptionLex })
    const { response: stream } = ctx
    assert.instanceOf(stream, XrpcStream)
    const msg = stream.message('#labels' as any, { seq: 1 } as any)
    assert.deepEqual(msg, { $type: 'com.example.test.sub#labels', seq: 1 })
  })
})

test.group('Macroable extension points', () => {
  test('XrpcContext / XrpcResponse / XrpcStream expose static .macro', ({ assert }) => {
    assert.isFunction((XrpcContext as any).macro)
    assert.isFunction((XrpcResponse as any).macro)
    assert.isFunction((XrpcStream as any).macro)
  })
})
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm quick:test --files tests/context.spec.ts`
Expected: PASS — all groups.

- [ ] **Step 4: Commit**

```bash
git add src/context.ts tests/context.spec.ts
git commit -m "feat(xrpc): add XrpcContext / XrpcResponse / XrpcStream (Macroable, ALS-backed)"
```

---

## Task 8b: `ExceptionHandler` base class in `src/exception_handler.ts`

**Files:**

- Create: `src/exception_handler.ts`
- Create: `tests/exception_handler.spec.ts`

**Why this exists:** Consumers register an XRPC error handler in `start/kernel.ts` via `xrpc.errorHandler(() => import('#exceptions/xrpc_handler'))` (the registration mechanism itself lands in Plan 04 as `XrpcService`). The handler class they author extends this base, which ships two responsibilities:

1. **Sanitization** — by default, transform unexpected errors into a generic `InternalServerError` in production (so internal exception messages / stack traces don't leak to the wire) and preserve the cause in development (so debugging works). Consumers who want different sanitization override `handle()`.
2. **Reporting** — a default no-op `report()` that consumers override to send to Sentry, structured logger, etc. Split from `handle()` so the two concerns can be customized independently — matches Adonis's own `ExceptionHandler` shape (`report` / `handle` / `shouldReport`).

The class is a concrete (non-abstract) class with sensible defaults — the stub published by configure (Plan 01 Task 5) ships a thin `super`-delegating subclass that consumers fill in.

`ctx` is typed `XrpcContext<XrpcLexicon> | null` because atcute-internal errors (request parsing failures, lexicon assertion errors raised before the executor materializes an `XrpcContext`) reach the handler with no context available. Plan 04's atcute hooks read `XrpcContext.get()` which returns `undefined` in that case — the hook passes `null` through.

**Steps:**

**Test discipline note**: TDD's RED step is skipped — the failure modes here would be "module not found" or "method not defined", both trivially predictable per the user's memory note. Implementation → tests → verify pass.

- [ ] **Step 1: Implement `src/exception_handler.ts`**

```ts
import type { ApplicationService } from '@adonisjs/core/types'

import { XrpcError, InternalServerError } from './errors.js'
import type { XrpcContext } from './context.js'
import type { XrpcLexicon } from './types.js'

/**
 * Base class for XRPC exception handlers. Consumers' `app/exceptions/xrpc_handler.ts`
 * extends this; Plan 04's `XrpcService.errorHandler(factory)` resolves the
 * consumer's subclass lazily on first error.
 *
 * Ships three methods:
 *  - `shouldReport(error)` — defaults to `true`. Override to suppress
 *    reporting for specific errors (validation failures the consumer
 *    doesn't want to log, etc.).
 *  - `report(error, ctx)`  — defaults to no-op. Override to add Sentry,
 *    structured logging, custom metrics, etc.
 *  - `handle(error, ctx)`  — returns the `XrpcError` that atcute will
 *    wire-encode as the response body. Defaults: `XrpcError` instances
 *    pass through unchanged; unexpected errors become a generic
 *    `InternalServerError` in production (no leak), or are wrapped in
 *    `InternalServerError` with `{ cause }` in development.
 *
 * The handler's constructor receives the `ApplicationService` via the
 * container (when Plan 04's `XrpcService.getRegisteredErrorHandler()`
 * resolves the registered subclass via `app.container.make(mod.default)`) —
 * `this.app.inProduction` drives the production-vs-development branch.
 */
export class ExceptionHandler {
  constructor(protected app: ApplicationService) {}

  /**
   * Override to suppress reporting for specific errors. Default: true
   * (report everything).
   */
  shouldReport(_error: unknown): boolean {
    return true
  }

  /**
   * Observation hook (Sentry, structured logging, custom metrics).
   * Default: no-op. Consumers add their reporting code by overriding.
   *
   * `ctx` is `null` for atcute-internal errors raised before the dispatch
   * executor materializes an `XrpcContext` (request parsing failures,
   * etc.) — guard with `ctx?.lexicon.id` etc.
   */
  async report(_error: unknown, _ctx: XrpcContext<XrpcLexicon> | null): Promise<void> {
    // No-op by default.
  }

  /**
   * Sanitize the error before atcute encodes it. Default behavior:
   *  - `XrpcError` instances pass through unchanged (already wire-shaped
   *    with stable `errorName` + safe `message`).
   *  - In production, unexpected errors are replaced with a generic
   *    `InternalServerError('Internal Server Error')` — preserves the
   *    100-level status without leaking internal messages / stacks.
   *  - In development, the original error's message is preserved on the
   *    `InternalServerError` along with `{ cause: error }` so developers
   *    can see the root cause in logs and clients see something useful.
   *
   * Override to customize sanitization. Call `super.handle(error, ctx)`
   * to keep the env-aware default behavior and layer custom logic on top.
   */
  async handle(error: unknown, _ctx: XrpcContext<XrpcLexicon> | null): Promise<XrpcError> {
    if (error instanceof XrpcError) return error
    if (this.app.inProduction) {
      return new InternalServerError('Internal Server Error')
    }
    return new InternalServerError(error instanceof Error ? error.message : String(error), {
      cause: error,
    })
  }
}
```

- [ ] **Step 2: Write tests**

Create `tests/exception_handler.spec.ts`:

```ts
import { test } from '@japa/runner'
import { setupApp } from './helpers.js'
import { ExceptionHandler } from '../src/exception_handler.js'
import { XrpcError, InternalServerError, NotFoundError } from '../src/errors.js'

test.group('ExceptionHandler — defaults', () => {
  test('shouldReport returns true by default', async ({ assert }) => {
    const { app } = await setupApp({})
    const handler = new ExceptionHandler(app)
    assert.isTrue(handler.shouldReport(new Error('whatever')))
  })

  test('report is a no-op by default', async ({ assert }) => {
    const { app } = await setupApp({})
    const handler = new ExceptionHandler(app)
    // Just assert it doesn't throw and resolves to undefined
    const result = await handler.report(new Error('whatever'), null)
    assert.isUndefined(result)
  })

  test('handle passes through XrpcError instances unchanged', async ({ assert }) => {
    const { app } = await setupApp({})
    const handler = new ExceptionHandler(app)
    const original = new NotFoundError('missing thing')
    const result = await handler.handle(original, null)
    assert.strictEqual(result, original)
  })

  test('handle wraps unexpected errors with InternalServerError and preserves cause in development', async ({
    assert,
  }) => {
    const { app } = await setupApp({}) // default env = test (not production)
    const handler = new ExceptionHandler(app)
    const original = new Error('something broke internally')
    const result = await handler.handle(original, null)
    assert.instanceOf(result, InternalServerError)
    assert.equal(result.message, 'something broke internally')
    assert.strictEqual((result as any).cause, original)
  })

  test('handle replaces unexpected errors with a generic InternalServerError in production', async ({
    assert,
  }) => {
    const { app } = await setupApp({})
    // Force production mode for this assertion. Adonis's `app.inProduction`
    // reads from `NODE_ENV` — set it before the assertion and restore after.
    const originalEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const prodHandler = new ExceptionHandler(app)
      // Re-read app.inProduction by spinning up a fresh app under production.
      // (If `app.inProduction` is cached at construction, this test needs a
      // setupApp variant that lets us pass `nodeEnvironment: 'production'`.)
      const result = await prodHandler.handle(new Error('internal detail'), null)
      assert.instanceOf(result, InternalServerError)
      assert.equal(result.message, 'Internal Server Error')
      assert.isUndefined((result as any).cause, 'cause must not leak in production')
    } finally {
      process.env.NODE_ENV = originalEnv
    }
  })

  test('handle wraps non-Error throwables (strings, plain objects) safely', async ({ assert }) => {
    const { app } = await setupApp({})
    const handler = new ExceptionHandler(app)

    const fromString = await handler.handle('a bare string was thrown', null)
    assert.instanceOf(fromString, InternalServerError)
    assert.equal(fromString.message, 'a bare string was thrown')

    const fromObject = await handler.handle({ weird: 'object' }, null)
    assert.instanceOf(fromObject, InternalServerError)
    assert.equal(fromObject.message, '[object Object]')
  })
})

test.group('ExceptionHandler — consumer subclass shape', () => {
  test('subclass can override report to capture errors', async ({ assert }) => {
    const captured: Array<{ error: unknown; nsid: string | undefined }> = []
    class TestHandler extends ExceptionHandler {
      async report(error: unknown, ctx: any) {
        captured.push({ error, nsid: ctx?.lexicon?.id })
      }
    }

    const { app } = await setupApp({})
    const handler = new TestHandler(app)
    await handler.report(new Error('boom'), null)
    assert.lengthOf(captured, 1)
    assert.equal((captured[0].error as Error).message, 'boom')
    assert.isUndefined(captured[0].nsid)
  })

  test('subclass calling super.handle keeps the sanitization default', async ({ assert }) => {
    let reportFired = 0
    class TestHandler extends ExceptionHandler {
      async report() {
        reportFired++
      }
      async handle(error: unknown, ctx: any) {
        // Custom: also count via report side-effect, then defer.
        if (this.shouldReport(error)) {
          await this.report(error, ctx)
        }
        return super.handle(error, ctx)
      }
    }

    const { app } = await setupApp({})
    const handler = new TestHandler(app)
    const result = await handler.handle(new Error('boom'), null)
    assert.equal(reportFired, 1)
    assert.instanceOf(result, InternalServerError)
    assert.equal(result.message, 'boom')
  })
})
```

If `setupApp` doesn't currently accept a `nodeEnvironment` option to drive the production-mode test, add one to `tests/helpers.ts` as part of this task — passing it through to the `IgnitorFactory` config so `app.inProduction` returns `true` under that fixture. (Confirm `setupApp`'s current shape against `tests/helpers.ts` at execution time; if a different mechanism for setting `NODE_ENV` per-test exists, prefer that.)

- [ ] **Step 3: Run tests to verify pass**

Run: `pnpm quick:test --files tests/exception_handler.spec.ts`

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/exception_handler.ts tests/exception_handler.spec.ts
git commit -m "feat(xrpc): add ExceptionHandler base class with env-aware default sanitization"
```

---

## Task 9: `XrpcContextFactory` in `factories/xrpc.ts`

**Files:**

- Create: `factories/xrpc.ts`
- Create: `tests/factory.spec.ts`

**Steps:**

- [ ] **Step 1: Implement `factories/xrpc.ts`**

Create `factories/xrpc.ts`:

```ts
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import type { HttpRequest, Logger } from '@adonisjs/core/http'
import type { ContainerResolver } from '@adonisjs/core/types/container'
import { XrpcContext } from '../src/context.js'
import type { XrpcLexicon, InferInput, InferParams } from '../src/types.js'

interface MergeParams<L extends XrpcLexicon> {
  lexicon: L
  request: HttpRequest
  input: unknown
  params: Record<string, any>
  signal: AbortSignal
  logger: Logger
  containerResolver: ContainerResolver
  requestId: string
}

/**
 * Test-facing builder for XrpcContext. Carries sensible defaults for every
 * field — tests merge only the fields that matter for the assertion under
 * test, parallel to Adonis's HttpContextFactory. Defaults derive from a
 * fresh `HttpContextFactory().create()` (same source the production
 * HTTP-path materialization uses via `fromHttpContext()` in Plan 03), so
 * test fixtures stay aligned with real dispatch.
 */
export class XrpcContextFactory {
  #params: Partial<MergeParams<XrpcLexicon>> = {}

  merge(params: Partial<MergeParams<XrpcLexicon>>): this {
    this.#params = { ...this.#params, ...params }
    return this
  }

  create<L extends XrpcLexicon>(): XrpcContext<L> {
    const lexicon = this.#params.lexicon as L | undefined
    if (!lexicon) {
      throw new Error('XrpcContextFactory: lexicon is required — call .merge({ lexicon }) first')
    }

    // Materialize defaults from a fresh HttpContext only when the caller
    // hasn't supplied them — most tests only care about lexicon / input /
    // params and let the rest default.
    const httpCtx = new HttpContextFactory().create()
    const request = this.#params.request ?? httpCtx.request
    const logger = this.#params.logger ?? httpCtx.logger
    const containerResolver = this.#params.containerResolver ?? httpCtx.containerResolver
    const requestId = this.#params.requestId ?? httpCtx.request.id() ?? 'test-req-id'
    const signal = this.#params.signal ?? new AbortController().signal

    return new XrpcContext<L>({
      lexicon,
      request,
      input: (this.#params.input as InferInput<L>) ?? (undefined as any),
      params: (this.#params.params as InferParams<L>) ?? ({} as InferParams<L>),
      signal,
      logger,
      containerResolver,
      requestId,
    })
  }
}
```

- [ ] **Step 2: Write tests for the factory**

Create `tests/factory.spec.ts`:

```ts
import { test } from '@japa/runner'
import { XrpcContextFactory } from '../factories/xrpc.js'
import { XrpcContext, XrpcResponse, XrpcStream } from '../src/context.js'

const procedureLex = { id: 'com.example.test.proc', type: 'xrpc_procedure' } as any
const subscriptionLex = { id: 'com.example.test.sub', type: 'xrpc_subscription' } as any

test.group('XrpcContextFactory', () => {
  test('throws if lexicon is not supplied', ({ assert }) => {
    assert.throws(() => new XrpcContextFactory().create(), /lexicon is required/)
  })

  test('creates an XrpcContext with defaults for procedure-kind lexicons', ({ assert }) => {
    const ctx = new XrpcContextFactory().merge({ lexicon: procedureLex }).create()
    assert.instanceOf(ctx, XrpcContext)
    assert.instanceOf(ctx.response, XrpcResponse)
    assert.deepEqual(ctx.params, {})
    assert.equal(ctx.input, undefined)
  })

  test('creates an XrpcContext with defaults for subscription-kind lexicons', ({ assert }) => {
    const ctx = new XrpcContextFactory().merge({ lexicon: subscriptionLex }).create()
    assert.instanceOf(ctx.response, XrpcStream)
  })

  test('forwards merged input / params overrides', ({ assert }) => {
    const ctx = new XrpcContextFactory()
      .merge({
        lexicon: procedureLex,
        input: { reasonType: 'spam' },
        params: { limit: 50 },
      })
      .create()
    assert.deepEqual(ctx.input, { reasonType: 'spam' })
    assert.deepEqual(ctx.params, { limit: 50 })
  })

  test('defaults logger / containerResolver / request from a fresh HttpContextFactory', ({
    assert,
  }) => {
    const ctx = new XrpcContextFactory().merge({ lexicon: procedureLex }).create()
    assert.isFunction(ctx.logger.info)
    assert.isObject(ctx.containerResolver)
    assert.isFunction((ctx.request as any).header) // Adonis HttpRequest API surface
  })
})
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm quick:test --files tests/factory.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 4: Commit**

```bash
git add factories/xrpc.ts tests/factory.spec.ts
git commit -m "feat(xrpc): add XrpcContextFactory for test construction"
```

---

## Task 10: Wire up subpath exports and `index.ts`

**Files:**

- Modify: `index.ts`
- Modify: `package.json` (exports + tsdown.entry)

**Steps:**

- [ ] **Step 1: Replace `index.ts` contents**

Replace `index.ts` with:

```ts
/*
|--------------------------------------------------------------------------
| Package entrypoint — public surface
|--------------------------------------------------------------------------
*/

export { configure } from './configure.js'
export { stubsRoot } from './stubs/main.ts'
export { defineConfig } from './src/define_config.js'

// Builders
export { XrpcRouter, XrpcRoute, XrpcRouteGroup } from './src/router.js'

// Runtime context types
export { XrpcContext, XrpcResponse, XrpcStream } from './src/context.js'

// Exception handler base class (consumer's app/exceptions/xrpc_handler.ts extends this)
export { ExceptionHandler } from './src/exception_handler.js'

// Errors (full hierarchy)
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

// Types
export type {
  XrpcConfig,
  XrpcProviderConfig,
  XrpcLexicon,
  XrpcProcedureLexicon,
  XrpcQueryLexicon,
  XrpcSubscriptionLexicon,
  InferInput,
  InferParams,
  InferOutput,
  XrpcMessage,
  XrpcMessageRef,
  XrpcMessagePayload,
} from './src/types.js'
```

- [ ] **Step 2: Extend `package.json` subpath exports**

In `package.json`, replace the existing `exports` block with:

```json
"exports": {
  ".": "./build/index.js",
  "./provider": "./build/providers/provider.js",
  "./services/xrpc": "./build/services/xrpc.js",
  "./types": "./build/src/types.js",
  "./factories/xrpc": "./build/factories/xrpc.js",
  "./errors": "./build/src/errors.js"
},
```

Note: `./services/xrpc` ships from here (the file is scaffolded in the initial commit; Plan 04 fills in the singleton accessor body). `./middleware`, `./test_utils`, and `./event-stream/framing` subpaths are added in Plan 03; `./hooks` lands in Plan 07. `XrpcSerializer` stays internal in v1 — no `./serializer` subpath ships (see Plan 02 § _Descoped from v1_ for the rationale). Keeping the export map honest is part of the contract.

- [ ] **Step 3: Extend `tsdown.entry`**

In `package.json`, replace the existing `tsdown.entry` array with:

```json
"entry": [
  "./index.ts",
  "./configure.ts",
  "./providers/provider.ts",
  "./services/xrpc.ts",
  "./src/types.ts",
  "./src/router.ts",
  "./src/context.ts",
  "./src/exception_handler.ts",
  "./src/errors.ts",
  "./src/utils.ts",
  "./factories/xrpc.ts"
],
```

- [ ] **Step 4: Run the full lint + typecheck + test pipeline**

Run: `pnpm test`
Expected: PASS — lint, format check, typecheck, all tests.

- [ ] **Step 5: Verify the published type-shape with `attw`**

Run: `pnpm build && pnpm types:check`
Expected: ESM-only and node16 profiles both PASS.

- [ ] **Step 6: Commit**

```bash
git add index.ts package.json
git commit -m "feat(xrpc): wire up subpath exports and tsdown entries for foundation surface"
```

---

## Task 11: Changeset entry

**Files:**

- Create: `.changeset/<auto-generated>.md`

**Steps:**

- [ ] **Step 1: Generate a changeset**

Run: `pnpm changeset`

Walk the prompt:

- Selected package: `@thisismissem/adonisjs-atproto-xrpc`
- Bump type: **minor** (this is the first published feature surface; v0.x minor is the right knob)
- Summary: `Add foundational primitives: lexicon-type re-exports, XrpcError hierarchy, defineConfig with DID validation, route builders (no auth — see Plan 05), Web ↔ Adonis request/response conversion utilities, runtime context/response/stream, and XrpcContextFactory.`

- [ ] **Step 2: Commit the changeset**

```bash
git add .changeset/
git commit -m "chore: changeset for foundation surface"
```

---

## Self-review

Run through this checklist before handing off:

- [ ] **Spec coverage:** Each item below has a task above (or is explicitly out of scope per the "Out of scope" header section).
  - `src/errors.ts` hierarchy — Task 3 ✓
  - `defineConfig` typing + DID validation — Task 4 ✓
  - Configure command + `useAsyncLocalStorage` check + config stub — Task 5 ✓
  - `XrpcRouter` / `XrpcRoute` / `XrpcRouteGroup` (no auth) — Task 6 ✓
  - Web ↔ Adonis request/response conversion utilities — Task 7 ✓
  - `XrpcContext` / `XrpcResponse` / `XrpcStream` (no auth) — Task 8 ✓
  - `XrpcContextFactory` — Task 9 ✓
  - Public exports + tsdown entries — Task 10 ✓
  - `XrpcSerializer` — out of scope, Plan 02 ✓
  - `src/xrpc_server.ts` / middleware / WebSocket — out of scope, Plan 03 ✓
  - Provider lifecycle / `XrpcService` — out of scope, Plan 04 ✓
  - `src/auth.ts` and `.auth` / `.serviceAuth()` — out of scope, Plan 05 ✓
  - Ace commands — out of scope, Plan 06 ✓
  - `indexXrpc()` codegen — out of scope, Plan 07 ✓

- [ ] **Type consistency:** `procedure / query / subscription` accept `XrpcHandlerInput` (the user-facing union); `RouteInfo['handler']` is `NormalizedHandler` (the post-`#normalizeHandler` discriminated shape Plan 03's executor consumes). `XrpcContext.response` is conditionally typed against `L extends XrpcSubscriptionLexicon`. The factory returns `XrpcContext<L>` with the same generic parameter the caller supplies.

- [ ] **Forward-compat hooks for later plans:** The plan deliberately leaves these extension points in place:
  - `XrpcRoute` and `XrpcRouteGroup` extend `Macroable` so Plan 05 can attach `.serviceAuth(...)` via `.macro()`.
  - `XrpcContext` extends `Macroable` so Plan 05 can attach `auth: XrpcAuth` via getter macro.
  - `XrpcRouter.routeFor(nsid)` lookup exists so Plan 05's group fan-out can resolve routes by NSID.
  - `RouteInfo` exports as an interface so Plan 05 can declaration-merge an `auth: RouteAuthDecl` field onto it.

- [ ] **No placeholder text:** Grep for `TODO`, `FIXME`, `TBD` in the plan; only references should be in the spec-quoted comments.

---

## Execution handoff

**Plan complete and saved to `docs/plans/2026-05-23-xrpc-plan-01-foundation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Plans 02–07 still need to be drafted before any execution starts. Common pattern: draft all plans first, then execute.
