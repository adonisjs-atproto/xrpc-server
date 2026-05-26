---
'@thisismissem/adonisjs-atproto-xrpc': minor
---

**Plan 04 — Provider: XrpcService, error reporting, and graceful shutdown**

New consumer-facing additions:

- **`XrpcService`** (`services/xrpc` singleton + `export type` from the main entrypoint) — consumer-facing facade for registering an error handler via `xrpc.errorHandler(() => import('#exceptions/xrpc_handler'))`.
- **`ExceptionHandler`** base class now wired end-to-end: the provider installs atcute `handleException` / `onSocketError` hooks that invoke the registered handler's `report()` + `handle()` methods with REPORTED-symbol deduplication to prevent double-invocation.
- **Graceful WebSocket shutdown** — `XrpcServer.shutdown(graceMs?)` sends 1001 close frames to connected subscription clients, waits up to `graceMs` for acks, then force-terminates survivors. Hooked into `app.terminating()` in the correct LIFO order so WS clients drain before the HTTP server closes.
- **`services/xrpc` subpath** — top-level-await singleton accessor, mirrors `@adonisjs/core/services/server`.
