import app from '@adonisjs/core/services/app'
import type { XrpcService } from '../src/xrpc_service.js'

let xrpc!: XrpcService

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
