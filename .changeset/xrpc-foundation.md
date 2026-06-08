---
'@thisismissem/adonisjs-atproto-xrpc': minor
---

Initial release of `@thisismissem/adonisjs-atproto-xrpc`.

**Route registration** — declare XRPC methods on `router.xrpc`:

```ts
router.xrpc.query(ComAtprotoRepoDescribeRepo, async (ctx) => { ... })
router.xrpc.procedure(ComAtprotoRepoPutRecord, async (ctx) => { ... })
router.xrpc.subscription(ComAtprotoSyncSubscribeRepos, async function* (ctx) { ... })
```

**Handler context** — every handler receives an `XrpcContext<L>`:

- `ctx.lexicon` — the registered lexicon schema
- `ctx.params` — validated, typed query / path parameters
- `ctx.input` — validated, typed request body (procedures only)
- `ctx.response` — chainable response builder (`.status()`, `.header()`, `.json()`, `.redirect()`)
- `ctx.stream` — subscription stream helper with typed `.message()` builder
- `ctx.request`, `ctx.logger`, `ctx.signal`, `ctx.containerResolver`, `ctx.requestId`

**Error types** — throw these from handlers to send a typed XRPC error response:

```ts
import {
  AuthRequiredError, ForbiddenError, InvalidRequestError,
  InvalidResponseError, MethodNotImplementedError, NotFoundError,
  PayloadTooLargeError, UnsupportedAlgorithmError, UpstreamFailureError,
} from '@thisismissem/adonisjs-atproto-xrpc/errors'
```

**Exception handler** — extend `ExceptionHandler` to control error reporting and sanitization:

```ts
export default class XrpcHandler extends ExceptionHandler {
  async report(error: unknown, ctx: XrpcOperationContext | null) { ... }
  async handle(error: unknown, ctx: XrpcOperationContext | null): Promise<XrpcError> { ... }
}
```

**Configuration** — `defineConfig` in `config/atproto_xrpc.ts`:

```ts
export default defineConfig({ serviceDid: env.get('ATPROTO_SERVICE_DID') })
```

**Type inference helpers** — `InferInput<L>`, `InferOutput<L>`, `InferParams<L>`, `MessageOf<L>` for deriving TypeScript types from lexicon schemas.

**Test factory** — `XrpcContextFactory` (from `./factories/xrpc`) constructs typed context instances with sensible defaults for unit tests.
