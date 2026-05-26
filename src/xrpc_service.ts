import type { ApplicationService } from '@adonisjs/core/types'
import type { LazyImport } from '@poppinss/utils/types'

import type { ExceptionHandler } from './exception_handler.js'

/**
 * Module marker stamped on errors after the consumer's handler has run
 * once. Used by atcute's HTTP-path `handleException` hook (Task 4's
 * `makeAtcuteHttpHook`) to skip re-invoking the consumer handler when
 * the executor catch already ran it. (Subscription-path handler-side
 * errors don't need the dedup — atcute has no equivalent subscription
 * hook; `wrapSubscriptionIterator`'s catch is the single report site.)
 *
 * The executor catch (Task 3) and the subscription wrapper catch stamp
 * this on the returned XrpcError before re-throwing. Plan 04 Task 4's
 * `makeAtcuteHttpHook` (HTTP) checks for it and short-circuits.
 *
 * @internal
 */
export const REPORTED: unique symbol = Symbol('xrpc:reported')

/**
 * The bound-as-`'xrpc'` consumer-facing facade.
 *
 * `XrpcService` is the public XRPC API surface; `XrpcServer` (in
 * `src/xrpc_server.ts`) is the internal dispatch orchestrator and never
 * imported by consumers. Mirrors how Adonis splits `server` (consumer-facing
 * singleton at `@adonisjs/core/services/server`) from internal HTTP machinery.
 *
 * `errorHandler(factory)` is late-bound: `start/kernel.ts` runs after `boot()`
 * (kernel.ts is loaded as a preload), so this instance must exist before
 * the registration call. The factory is held until first resolution; the
 * resolved instance is memoized for subsequent calls. Same pattern as
 * `server.errorHandler(...)` in Adonis core.
 *
 * The factory must point at a module whose default export is a class
 * extending the `ExceptionHandler` base class shipped by this package
 * (`@thisismissem/adonisjs-atproto-xrpc#ExceptionHandler`). Plan 01's
 * configure command publishes the consumer's `app/exceptions/xrpc_handler.ts`
 * starter file with the right subclass shape.
 */
export class XrpcService {
  #app: ApplicationService
  #errorHandlerFactory?: LazyImport<new (...args: any[]) => ExceptionHandler>
  #resolvedErrorHandler?: ExceptionHandler

  constructor(app: ApplicationService) {
    this.#app = app
  }

  /**
   * Register the consumer's `ExceptionHandler` subclass. Called from
   * `start/kernel.ts`:
   *
   * ```ts
   * import xrpc from '@thisismissem/adonisjs-atproto-xrpc/services/xrpc'
   * xrpc.errorHandler(() => import('#exceptions/xrpc_handler'))
   * ```
   *
   * The factory is invoked lazily on first error; the resolved instance is
   * memoized.
   */
  errorHandler(factory: LazyImport<new (...args: any[]) => ExceptionHandler>): this {
    this.#errorHandlerFactory = factory
    return this
  }

  /**
   * Resolve and memoize the registered exception handler. Called by the
   * executor's catch blocks, by `wrapSubscriptionIterator`'s catch block,
   * and by Plan 04's atcute hooks (all via the `xrpc` dep). Returns null
   * if no factory was registered (tests, or consumers who haven't set up
   * `start/kernel.ts` registration yet) — callers tolerate null by
   * skipping the report/handle invocation.
   *
   * @internal
   */
  async getRegisteredErrorHandler(): Promise<ExceptionHandler | null> {
    if (this.#resolvedErrorHandler) return this.#resolvedErrorHandler
    if (!this.#errorHandlerFactory) return null
    const mod = await this.#errorHandlerFactory()
    this.#resolvedErrorHandler = await this.#app.container.make(mod.default)
    return this.#resolvedErrorHandler
  }
}
