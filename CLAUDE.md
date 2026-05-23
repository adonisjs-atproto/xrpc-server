# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this package is

`@thisismissem/adonisjs-atproto-xrpc` is an **AdonisJS v7+ provider** that bridges AdonisJS's HTTP/router conventions to AT Protocol XRPC server-side dispatch, wrapping [`@atcute/xrpc-server`](https://www.npmjs.com/package/@atcute/xrpc-server) and its Node WebSocket adapter. It is the framework half; consumers (e.g. `@thisismissem/adonisjs-atproto-labeler`) bring their own lexicons and handlers.

**Status: brand-new, mostly scaffolding.** A single initial commit. The shape is set; almost no behaviour is implemented yet. Before doing non-trivial work, read the canonical design spec:

- `docs/specs/2026-05-17-adonisjs-atproto-xrpc-design.md`

That spec defines the planned `router.xrpc.{procedure,query,subscription}` builder, the `XrpcContext<L>` type, the server-level `/xrpc/*` dispatch middleware, the WebSocket `upgrade`-handler integration, and the service-JWT middleware. **When the current code disagrees with the spec, the spec wins**

## Commands

This is an **ESM-only** package on **Node 24+**. Use `pnpm` (per `packageManager` field and Emelia's global rules).

| Task                                          | Command                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| Run the test suite (lint + typecheck + tests) | `pnpm test`                                                                        |
| Run tests only, skip lint/typecheck           | `pnpm quick:test`                                                                  |
| Filter tests                                  | `pnpm quick:test --files <glob>` / `--groups <name>` / `--tests <name>` (Japa CLI) |
| Typecheck only                                | `pnpm typecheck`                                                                   |
| Lint (also runs typecheck)                    | `pnpm lint`                                                                        |
| Format / check formatting                     | `pnpm format` / `pnpm format:check`                                                |
| Build (tsdown JS + tsc d.ts + copy stubs)     | `pnpm build` (prefer `yalc publish`)                                               |
| Check the published type-shape (`attw`)       | `pnpm types:check`                                                                 |
| Create a changeset                            | `pnpm changeset`                                                                   |
| Publish for development                       | `yalc publish`                                                                     |

**Important**: `pretest` runs `pnpm lint` (which itself runs `typecheck`), so `pnpm test` is the full pipeline. Use `pnpm quick:test` as the inner-loop command. CI mirrors this — `.github/workflows/checks.yml` runs `lint`, `format:check`, `typecheck`, `types:check`, and `test` on Ubuntu + Windows.

## Architecture

### Package layout (AdonisJS convention)

```
index.ts            re-exports public API: configure, stubsRoot, defineConfig, types
configure.ts        Adonis configure hook (publishes config stub, registers provider in adonisrc)
providers/          provider class (register/boot/ready/shutdown)
services/           singleton accessors meant to be imported by consumers
src/                internal implementation: define_config, types, builders, middleware, errors
stubs/              .stub templates copied verbatim into consumer apps by the configure hook
bin/test.ts         Japa entrypoint
tests/              specs + helpers.ts (IgnitorFactory + TestUtilsFactory bootstrap)
```

The published artifact (`build/`) is produced by **two compilers** in sequence:

1. `tsdown` emits unbundled ESM JS into `build/` (see `package.json#tsdown`).
2. `tsc --emitDeclarationOnly` emits `.d.ts` alongside.
3. `postcompile` (`copy:templates`) copies `stubs/**/*.stub` into `build/` — stubs are templates, not TypeScript, and don't go through either compiler.

Subpath exports are declared explicitly in `package.json#exports`; when adding a new public surface, add the entry to both `exports` and `tsdown.entry`.

### Test bootstrap pattern

`tests/helpers.ts` exposes `setupApp(parameters, hooks)` which:

- Boots an isolated AdonisJS app under `tests/../tmp/` using `IgnitorFactory` + `TestUtilsFactory`.
- Wires `@adonisjs/lucid` against an in-memory `better-sqlite3` database.
- Accepts a `beforeReady` hook for tests that need to swap container bindings between `app.boot()` and provider `ready()`.
- Auto-registers app teardown via `getActiveTest()?.cleanup(...)`, but if called from `group.each.setup` (where no active test exists yet), the caller **must `return terminate`** so Japa's setup-teardown convention picks it up.

The provider import inside `setupApp` is currently commented out — uncomment when wiring it for real. `tests/configure.spec.ts` has its own bespoke ignitor setup (it tests the `configure` command end-to-end, so it needs a tighter-controlled app shell); don't try to fold it into the shared helper.

### Releasing

Releases are fully automated through **Changesets + npm OIDC (trusted publishing)**:

- `.github/workflows/release.yml` runs on every push to `main`.
- The changesets action either opens a "Prepare release" PR (rolling up pending changesets) or, when that PR is merged, runs `pnpm run release` which builds and `changeset publish`es.
- npm auth is via OIDC (no `NPM_TOKEN` secret); `publishConfig.provenance: true` is set.
- Add a changeset for any user-facing change: `pnpm changeset`, commit the generated markdown file.

**Never run any `*publish*` command locally** (see Emelia's global rules in `~/.claude/CLAUDE.md`). Publishing to npm is GHA + human-initiated only. The one exception is `yalc publish`, which pushes to the local `~/.yalc` store (not any public registry) and is the dev-loop mechanism for making this package consumable from sibling consumer repos via `file:.yalc/...` dependencies.

## Conventions specific to this repo

- **ESLint preset** is `@adonisjs/eslint-config`'s `configPkg()` — the package-author variant. Don't add custom rules without reason.
- **Prettier** uses `@adonisjs/prettier-config`.
- **cspell** has a tailored word list in `cspell.json` (`atcute`, `atproto`, `bsky`, `Ignitor`, `japa`, `lexicons`, `xrpc`, `yalc`, etc.) — add new project-specific terms there if cspell flags them.
- Comments in the existing code follow Emelia's "why, not what" rule — see `providers/provider.ts` for the pattern (each non-obvious block has a short note explaining the constraint that motivated it). Match that register; don't add boilerplate JSDoc.
- The `README.md` is intentionally minimal right now; expand it only when consumer-facing API stabilises.

## Related repositories

- **`adonisjs-atproto-labeler`** — sibling AdonisJS package; will be the first consumer of this one. Currently holds the existing closure-based `subscribeLabels` handler that the design spec plans to migrate onto this package's `router.xrpc.subscription(...)` API.
- **`simple-atproto-labeler`** — the application that motivated the extraction.

Both of these repositories can be found one directory up.
