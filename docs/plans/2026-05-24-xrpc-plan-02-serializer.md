# XRPC Plan 02 — Serializer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `XrpcSerializer` — the internal subclass of `BaseSerializer` (from `@adonisjs/core/transformers`, the re-export path of `@adonisjs/http-transformers`) that the dispatch layer (Plan 03) calls to unpack transformer contracts (`Item` / `Collection`) before atcute frames the result onto the wire. Stays internal — no `index.ts` re-export, no subpath, no `defineConfig({ serializer })` consumer slot in v1. If a real consumer use case for customizing the serializer surfaces post-v1, exposing the class + adding the config knob is a non-breaking additive change.

**Architecture:** Tiny: one class with two members (`wrap = undefined`, identity `definePaginationMetaData`). XRPC outputs aren't wrapped under a `data` key (the wire format is `InferOutput<L>` directly, no envelope), and the package has no opinion on what pagination meta should look like — the lexicon's output schema is the contract, so identity passthrough is the only safe default. The serializer becomes interesting only by virtue of `BaseSerializer.serializeWithoutWrapping()` being the hook the executor uses to walk `Item` / `Collection` / `Paginator` contracts that handlers embed into their return value.

**Tech Stack:** TypeScript (ESM), Node ≥24. No new dependencies — `@adonisjs/http-transformers` is already a transitive dep of `@adonisjs/core` (which we have as a peer) and re-exported under the `@adonisjs/core/transformers` subpath. The spec calls this out explicitly. Tests use `@japa/runner` + `@japa/assert` and `app.container.createResolver()` for the `ContainerResolver` argument.

**Spec reference:** `docs/specs/2026-05-21-adonisjs-atproto-xrpc-design.md` § _Transformer integration_ — the canonical design this plan implements.

**Depends on:** Plan 01 (foundation) — `src/types.ts` provides `XrpcLexicon` / `InferOutput`, `XrpcResponseBody` is the return-type shape this serializer ultimately produces. Plan 02 does NOT import from `src/router.ts` or `src/context.ts` — the serializer is dispatch-input-shape-agnostic.

---

## Files

### Create

- `src/serializer.ts` — `XrpcSerializer` class (~20 lines)
- `tests/serializer.spec.ts` — unit tests for the wrap/no-wrap behavior, identity pagination meta, and end-to-end transformer-contract unpacking

### Modify

- `package.json` — extend `tsdown.entry` (no new deps; no new subpath export — see Tech Stack note above and Task 1 import line)
- `README.md` — add a `## Pagination` section documenting the flat `{ cursor, <pluralized>: Transformer.transform(...) }` pattern and the trap of reaching for `BaseTransformer.paginate(...)`

### Out of scope (later plans)

- **Public re-export of `XrpcSerializer` from `index.ts`** — descoped from v1 entirely (not a Plan 04 deliverable either). No consumer use case exists today; shipping the export ahead of demand would be public API ahead of need. If a consumer surfaces a real reason to customize the serializer post-v1, adding the re-export + a `defineConfig({ serializer })` slot is purely additive (non-breaking).
- **Consumer-facing `defineConfig({ serializer: ... })` slot in `XrpcConfig`** — descoped from v1 for the same reason. The spec (`2026-05-21-adonisjs-atproto-xrpc-design.md` § _Transformer integration_) currently says "exposed as a config knob"; that line will need amending to reflect v1 ships without it.
- Executor wiring (`xrpcSerializer.serializeWithoutWrapping(...)` inside the dispatch path) → Plan 03 (dispatch). Plan 03 / Plan 04 construct `XrpcSerializer` directly with `new XrpcSerializer()` — no config indirection.
- Subscription-frame serialization (the executor wraps the user's async-generator with `wrapSubscriptionIterator(...)` which also calls the serializer) → Plan 03 (dispatch)
- A `./serializer` subpath export — irrelevant given the class stays internal in v1. If it ever does go public post-v1, re-exporting from the main `index.ts` would be enough; subpaths in this package are reserved for surfaces that consumers genuinely need outside the main entrypoint.

---

## Pre-flight checks

- [ ] **Step 0a: Confirm we are on a clean working tree and Plan 01 is committed**

Run:

```bash
git status
git log --oneline -5
```

Expected: working tree clean (or only this plan file untracked); commits from Plan 01 reachable. If Plan 01 has been executed, the most recent commits will include the Plan 01 task commits (`feat(xrpc): add @atcute/lexicons and @poppinss/macroable deps`, `feat(xrpc): replace placeholder types...`, etc.). If Plan 01 has NOT yet executed, this plan can still be drafted — it depends on Plan 01's _shape_, not on its executed state. Note the state and proceed.

- [ ] **Step 0b: Confirm `@adonisjs/core/transformers` re-exports `BaseSerializer`**

`@adonisjs/core` depends on `@adonisjs/http-transformers ^2.3.1` and re-exports it under the `./transformers` subpath. We use that re-export rather than adding `@adonisjs/http-transformers` as a direct dep — fewer entries in `package.json`, and the spec's _Transformer integration_ section names this path explicitly.

Run:

```bash
pnpm info @adonisjs/core exports | grep -i transformer
node -e "console.log(Object.keys(await import('@adonisjs/core/transformers')))"
```

Expected: the first command prints `'./transformers': './build/modules/transformers/main.js'`; the second prints an array including `BaseSerializer`, `BaseTransformer`, `Item`, `Collection`, `Paginator`. If `BaseSerializer` isn't in that list, fall back to a direct `pnpm add @adonisjs/http-transformers` and adjust the import paths in Task 1 — but the re-export is the expected case.

---

## Task 1: Implement `XrpcSerializer`

**Files:**

- Create: `src/serializer.ts`
- Create: `tests/serializer.spec.ts`

The serializer extends `BaseSerializer<{ PaginationMetaData: unknown }>`. `wrap` is `undefined` because XRPC wire format is the bare output object (no envelope key). `definePaginationMetaData` is the identity function because the package has no opinion on pagination shape — the lexicon's output schema (e.g. `subscribeLabels`'s `cursor` field, or `listReports`'s `cursor` field) is the contract, and the consumer's transformer is responsible for producing it.

All imports go through `@adonisjs/core/transformers` (the re-export path) — confirmed in Step 0b. The test relies on three things from that re-export that the BaseSerializer machinery does for us:

1. `serialize(value, resolver)` returns the unpacked result (transformer contracts walked, items materialized, async work awaited) wrapped under `this.wrap` if set.
2. `serializeWithoutWrapping(value, resolver)` does the same minus the wrap step.
3. The resolver argument is an `app.container.createResolver()` — we get one via `app.container.createResolver()` in the test setup.

**Steps:**

- [ ] **Step 1: Write the failing test**

Create `tests/serializer.spec.ts`:

```ts
import { test } from '@japa/runner'
import { BaseTransformer, Item, Collection } from '@adonisjs/core/transformers'
import { setupApp } from './helpers.js'
import { XrpcSerializer } from '../src/serializer.js'

class UserTransformer extends BaseTransformer<{ id: number; name: string }> {
  toObject() {
    return { id: this.resource.id, name: this.resource.name }
  }
}

test.group('XrpcSerializer', (group) => {
  group.each.setup(() => setupApp({ environment: 'web' }))

  test('wrap is undefined (XRPC has no envelope key)', ({ assert }) => {
    const serializer = new XrpcSerializer()
    assert.equal(serializer.wrap, undefined)
  })

  test('definePaginationMetaData returns the input unchanged (identity)', ({ assert }) => {
    const serializer = new XrpcSerializer()
    const meta = { cursor: 'abc', limit: 50 }
    assert.strictEqual(serializer.definePaginationMetaData(meta), meta)
  })

  test('serialize unpacks an Item contract to the transformed object', async ({ assert, app }) => {
    const serializer = new XrpcSerializer()
    const resolver = app.container.createResolver()
    const item = Item.create({ id: 1, name: 'Alice' }, UserTransformer)
    const result = await serializer.serialize(item, resolver)
    assert.deepEqual(result, { id: 1, name: 'Alice' })
  })

  test('serialize unpacks a Collection contract to an array of transformed objects', async ({
    assert,
    app,
  }) => {
    const serializer = new XrpcSerializer()
    const resolver = app.container.createResolver()
    const collection = Collection.create(
      [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
      UserTransformer
    )
    const result = await serializer.serialize(collection, resolver)
    assert.deepEqual(result, [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ])
  })

  test('serializeWithoutWrapping behaves identically because wrap is already undefined', async ({
    assert,
    app,
  }) => {
    const serializer = new XrpcSerializer()
    const resolver = app.container.createResolver()
    const item = Item.create({ id: 1, name: 'Alice' }, UserTransformer)
    const wrapped = await serializer.serialize(item, resolver)
    const unwrapped = await serializer.serializeWithoutWrapping(item, resolver)
    assert.deepEqual(wrapped, unwrapped)
  })

  test('serialize passes plain objects through untouched (no transformer contract)', async ({
    assert,
    app,
  }) => {
    const serializer = new XrpcSerializer()
    const resolver = app.container.createResolver()
    const plain = { reportId: 'abc', createdAt: '2026-05-24T00:00:00Z' }
    const result = await serializer.serialize(plain, resolver)
    assert.deepEqual(result, plain)
  })

  test('serialize unpacks a Collection nested in atproto-canonical paginated shape', async ({
    assert,
    app,
  }) => {
    // atproto's paginated XRPC convention is a flat output body:
    // `{ cursor?: string, <pluralized-field-name>: [...] }` — e.g.
    // `app.bsky.graph.getFollowers` returns `{ cursor, followers }`,
    // `app.bsky.feed.getFeedSkeleton` returns `{ cursor, feed }`, etc.
    // (See atproto.com/guides/lexicon-style-guide#design-patterns.)
    // Consumers embed a Collection contract for the array field directly
    // inside that flat shape; they do NOT use the @adonisjs/http-transformers
    // Paginator contract, whose default `{ data, meta }` shape doesn't match
    // any atproto lexicon's output schema.
    const serializer = new XrpcSerializer()
    const resolver = app.container.createResolver()
    const response = {
      cursor: 'opaque-cursor-value',
      followers: Collection.create(
        [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        UserTransformer
      ),
    }
    const result = await serializer.serialize(response, resolver)
    assert.deepEqual(result, {
      cursor: 'opaque-cursor-value',
      followers: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
    })
  })
})
```

**Important — about the import paths**: The test imports `BaseTransformer`, `Item`, `Collection`, `Paginator` from `@adonisjs/core/transformers` (the re-export confirmed in Step 0b). If any of these symbols are missing from that re-export (`node -e "console.log(Object.keys(await import('@adonisjs/core/transformers')))"`), import the missing ones directly from `@adonisjs/http-transformers` and add it as a direct dep — but the Adonis core re-export is expected to cover all of them.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm quick:test --files tests/serializer.spec.ts`
Expected: FAIL with `Cannot find module '../src/serializer.js'`.

- [ ] **Step 3: Implement `src/serializer.ts`**

Create `src/serializer.ts`:

```ts
import { BaseSerializer } from '@adonisjs/core/transformers'

/**
 * The package's internal serializer for XRPC response bodies. Extends
 * `BaseSerializer` (re-exported from `@adonisjs/core/transformers`) to
 * unpack transformer contracts (`Item` / `Collection` / `Paginator`) that
 * consumer handlers embed into their return value, before atcute frames
 * the result onto the wire (JSON for procedure/query; CBOR for subscription
 * messages).
 *
 * Two design choices vs. the default serializer shape:
 *
 * - `wrap = undefined` — XRPC wire format is `InferOutput<L>` bare; there's
 *   no `data` envelope key. The lexicon's output schema is the contract.
 * - `definePaginationMetaData` is the identity function — the package has no
 *   opinion on what pagination meta should look like; the lexicon's output
 *   schema (e.g. `cursor: string`) is the source of truth, and the consumer's
 *   transformer / handler is responsible for producing that shape.
 *
 * Consumers who need to customize either can extend this class and pass
 * the subclass via `defineConfig({ serializer: MyXrpcSerializer })` once
 * Plan 04 lands the config slot.
 */
export class XrpcSerializer extends BaseSerializer<{
  PaginationMetaData: unknown
}> {
  wrap = undefined as undefined

  definePaginationMetaData(metaData: unknown): unknown {
    return metaData
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm quick:test --files tests/serializer.spec.ts`
Expected: PASS — 7 tests.

If any test fails because `BaseTransformer` / `Item` / `Collection` weren't found at the expected import path, refer back to Step 1's note and Step 0b's exports check — adjust the imports in the test (not the implementation) and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/serializer.ts tests/serializer.spec.ts
git commit -m "feat(xrpc): add XrpcSerializer extending BaseSerializer (wrap=undefined, identity pagination meta)"
```

---

## Task 2: Compile `XrpcSerializer` (internal-only in Plan 02)

**Files:**

- Modify: `package.json` (extend `tsdown.entry` only)

`XrpcSerializer` stays internal — no `index.ts` re-export, no consumer customization slot in v1 (YAGNI: no consumer has surfaced a need to customize the serializer). Plan 03's executor and Plan 04's provider both reach for it via the package-internal path (`../src/serializer.js`) and construct it directly with `new XrpcSerializer()` — same as the rest of the `src/` modules that live behind the public surface.

**Steps:**

- [ ] **Step 1: Run the full lint + typecheck + test pipeline**

Run: `pnpm test`
Expected: PASS — lint, format check, typecheck, all tests.

- [ ] **Step 2: Verify the published type-shape with `attw`**

Run: `pnpm build && pnpm types:check`
Expected: ESM-only and node16 profiles both PASS. `build/src/serializer.js` should exist as a sibling of the other compiled outputs. The `attw` report should NOT show `XrpcSerializer` as a public export at any subpath (since we haven't re-exported it).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat(xrpc): compile XrpcSerializer into the build (internal-only for now)"
```

---

## Task 3: Pagination section in README

**Files:**

- Modify: `README.md` (add `## Pagination` section)

The README currently only has Title + Installation + Configuring. Per the CLAUDE.md guidance ("expand only when consumer-facing API stabilises"), the introduction of `XrpcSerializer` and its specific quirk — that `BaseTransformer.paginate(...)` doesn't produce an XRPC-canonical shape — is the first consumer-facing-API moment that warrants a usage section. The pattern is non-obvious and silently wrong if a consumer reaches for the natural Adonis idiom, so documenting it once at the README level pays back every consumer's first pagination implementation.

Structure follows the `documentation-templates` skill's principles for README sections: examples first (show the canonical pattern), explain why (the trap with `paginate()`), self-contained (no required forward references), scannable (H3 sub-section for the warning, table for the structural-vs-semantic mismatch).

**Steps:**

- [ ] **Step 1: Append the `## Pagination` section to `README.md`**

Append the following to the existing `README.md` (after the `### Configuring` section, no blank-line tweaks needed elsewhere):

````markdown
## Pagination

XRPC paginated queries follow an atproto-canonical flat shape: an optional opaque `cursor` plus an array under a pluralized field name that comes from the lexicon (`followers`, `feed`, `posts`, …). For example:

```json
{
  "cursor": "NjU7Y3JlYXRlZEF0Cg",
  "followers": [{ "did": "did:example:1" }, { "did": "did:example:2" }]
}
```

The corresponding controller code for producing this is:

```ts
import type { XrpcContext } from '@thisismissem/adonisjs-atproto-xrpc'
import { app } from '#lexicons'
import Follower from '#models/follower'
import FollowerTransformer from '#transformers/follower_transformer'

async getFollowers(ctx: XrpcContext<typeof app.bsky.graph.getFollowers>) {
  const followers = await Follower.query()
    .where('subject', ctx.params.actor)
    .orderBy('createdAt', 'desc')
    .limit(ctx.params.limit ?? 50)

  return {
    cursor: followers.at(-1)?.id,
    followers: FollowerTransformer.transform(followers),
  }
}
```

### Why not `BaseTransformer.paginate(...)`?

The `Paginator` contract from `@adonisjs/http-transformers` produces `{ data: [...], metadata: {...} }`, which doesn't match the canonical atproto lexicon output schema and will fail response validation. Two reasons it doesn't fit:

| Mismatch             | Detail                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Structure**        | `BaseSerializer.serialize()` hardcodes `{ [wrap ?? 'data']: items, metadata: ... }` as the Paginator envelope. The subclassing knobs (`wrap`, `definePaginationMetaData`) can rename or retype the parts but can't change the outer shape. |
| **Pagination model** | Adonis paginators are page-number based (`currentPage`, `lastPage`, `total`). XRPC uses opaque cursors — there's no semantic mapping between the two metadata models.                                                                      |

If you reach for `paginate()` out of habit, the serializer doesn't intercept or reshape it — you'll just get a wire-format response that fails atcute's response-schema validation. Use the flat-shape pattern above instead.
````

The outer fence is four backticks (not three) so the inner three-backtick TypeScript block renders correctly when this snippet is itself pasted into the README. When applying the Edit, the appended markdown only uses three-backtick fences (the four-backtick fence above is a meta-quoting artifact of _this plan_ embedding markdown that embeds a TypeScript block — the README itself contains the inner content directly).

- [ ] **Step 2: Verify formatting + spell-check**

Run: `pnpm format:check && pnpm lint`
Expected: PASS — Prettier accepts the markdown as-is; cspell may flag domain-specific terms. If cspell flags `bsky`, `atproto`, `atcute`, `lexicons`, `Lexicon`, `nsid`, or similar — those are all in `cspell.json` already from Plan 01. Genuinely new project-specific terms (e.g., a transformer-method name) go into `cspell.json` per the README convention; common-English words that cspell flags get rephrased.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(xrpc): document pagination shape and the BaseTransformer.paginate trap"
```

---

## Task 4: Changeset entry

**Files:**

- Create: `.changeset/<auto-generated>.md`

**Steps:**

- [ ] **Step 1: Generate a changeset**

Run: `pnpm changeset`

Walk the prompt:

- Selected package: `@thisismissem/adonisjs-atproto-xrpc`
- Bump type: **patch** (v0.x, internal-only addition — XrpcSerializer is compiled into the build but not re-exported; the only consumer-visible change is the README pagination guidance, which is a docs-only update)
- Summary: `Document the canonical flat { cursor, <pluralized>: Transformer.transform(...) } shape for paginated XRPC queries, and the trap of reaching for BaseTransformer.paginate() which produces a non-XRPC shape. Internal: add XrpcSerializer (subclass of BaseSerializer) that Plan 03's dispatch will use to unpack transformer contracts; class stays internal until Plan 04 exposes the defineConfig({ serializer }) slot.`

- [ ] **Step 2: Commit the changeset**

```bash
git add .changeset/
git commit -m "chore: changeset for XrpcSerializer + pagination README"
```

---

## Self-review

Run through this checklist before handing off:

- [ ] **Spec coverage:** Each item below has a task above (or is explicitly out of scope per the "Out of scope" header section).
  - `XrpcSerializer` class with `wrap = undefined` — Task 1 ✓
  - `definePaginationMetaData` identity — Task 1 ✓
  - `XrpcSerializer` compiled into build (internal-only) — Task 2 ✓
  - README pagination guidance (canonical flat shape + `paginate()` trap) — Task 3 ✓
  - Public `XrpcSerializer` re-export — descoped from v1 ✓
  - `defineConfig({ serializer: ... })` slot — descoped from v1 (spec amendment needed; see "Spec drift" below) ✓
  - Executor wiring (`xrpcSerializer.serializeWithoutWrapping(...)`) — out of scope, Plan 03 ✓

- [ ] **Type consistency:** `XrpcSerializer` extends `BaseSerializer<{ PaginationMetaData: unknown }>`. The `Wrap` generic slot is unspecified (defaults to never / undefined per `BaseSerializer`'s shape); confirmed by `wrap = undefined as undefined`. The class has no other type parameters — `serialize` / `serializeWithoutWrapping` flow through the base class.

- [ ] **Forward-compat hooks for later plans:** No public extension points are reserved in v1 — `XrpcSerializer` stays internal. Adding a public re-export and a `defineConfig({ serializer })` slot in a later minor is purely additive (non-breaking): the existing internal `new XrpcSerializer()` construction site in Plan 03/04 becomes `new config.serializer()` with a default of `XrpcSerializer`. No state on the class would conflict with future subclassing.

- [ ] **Spec drift:** Resolved. `docs/specs/2026-05-21-adonisjs-atproto-xrpc-design.md` § _Transformer integration_ now states v1 ships internal-only and forward-points to _Future work_, which carries the "custom serializer via `defineConfig({ serializer })`" item as a post-v1 additive change.

- [ ] **No placeholder text:** Grep for `TODO`, `FIXME`, `TBD` in the plan; nothing should remain.

---

## Related follow-ups identified during drafting

These aren't part of Plan 02 scope but emerged from the Paginator decision and are worth recording for later:

- **Cursor-based pagination for Lucid.** Lucid's `paginate(page, perPage)` is offset/limit-only (LIMIT + OFFSET + COUNT). There's no native cursor primitive — meaning XRPC handlers that want lexicon-canonical opaque-cursor pagination have to roll their own (`WHERE id < ? ORDER BY id DESC LIMIT N`, encode/decode the cursor at the handler boundary). A `Lucid.query().paginateByCursor({ orderBy, perPage, cursor })` helper that handled keyset queries + opaque cursor encoding would benefit atproto consumers (and the broader Adonis ecosystem). Out of scope for this package — it's a Lucid feature gap. Recorded so the trail isn't lost.

- **Inertia precedent for `XrpcSerializer`'s shape.** Confirmed during drafting: `@adonisjs/inertia`'s `InertiaSerializer` ([`src/props.ts` on `1.x`](https://github.com/adonisjs/inertia/blob/1.x/src/props.ts)) is structurally identical to ours — `wrap = undefined`, identity `definePaginationMetaData`, no Paginator override. The decision to NOT override Paginator handling in `XrpcSerializer` is the same call Inertia made. Useful precedent to cite if a reviewer questions the shape later.

---

## Execution handoff

**Plan complete and saved to `docs/plans/2026-05-24-xrpc-plan-02-serializer.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Plans 03–07 still need to be drafted before any execution starts. Common pattern: draft all plans first, then execute.
