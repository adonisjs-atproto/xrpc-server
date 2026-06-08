---
'@thisismissem/adonisjs-atproto-xrpc': minor
---

**Error handler registration** — register a custom `ExceptionHandler` via the `xrpc` service in `start/kernel.ts`:

```ts
import xrpc from '@thisismissem/adonisjs-atproto-xrpc/services/xrpc'

xrpc.errorHandler(() => import('#exceptions/xrpc_handler'))
```

The handler's `report()` and `handle()` methods are called for both HTTP operation errors and WebSocket subscription errors. Errors already handled by `report()` are not double-reported if they propagate to `handle()`.

**Graceful WebSocket shutdown** — on `app.terminate()`, connected subscription clients receive a 1001 (Going Away) close frame and the server waits up to a configurable grace period before force-closing. No consumer configuration needed; the provider wires this automatically.
