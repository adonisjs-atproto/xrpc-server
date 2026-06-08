---
'@thisismissem/adonisjs-atproto-xrpc': minor
---

**Dispatch middleware** — mount `XrpcDispatchMiddleware` in `start/kernel.ts` to activate `/xrpc/*` routing:

```ts
import router from '@adonisjs/core/services/router'
import { middleware } from './kernel.js'

router.use([() => import('@thisismissem/adonisjs-atproto-xrpc/middleware')])
```

**Subscription testing** — `injectXrpcSubscription` (from `./test_utils`) opens a WebSocket to a running test server, decodes atproto frames, and exposes an `AsyncIterable<DecodedFrame>`:

```ts
import { injectXrpcSubscription } from '@thisismissem/adonisjs-atproto-xrpc/test_utils'

const frames = await injectXrpcSubscription(server, ComAtprotoSyncSubscribeRepos)
for await (const frame of frames) {
  // frame is DecodedFrame — discriminated union: { type: 'message', body } | { type: 'error', ... }
}
```

**atproto frame codec** — `decodeFrame` / `encodeFrame` / `DecodedFrame` exported from `./event-stream/framing` for consumers that need to work with raw WebSocket frames outside of the test helper.
