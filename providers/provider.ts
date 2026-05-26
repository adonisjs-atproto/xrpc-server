import { Router } from '@adonisjs/core/http'
import { XRPCRouter } from '@atcute/xrpc-server'
import { createNodeWebSocket } from '@atcute/xrpc-server-node'
import type { ApplicationService } from '@adonisjs/core/types'

import { XrpcRouter } from '../src/router/index.js'
import { XrpcServer, createXrpcExecutor } from '../src/xrpc_server.js'
import { XrpcSerializer } from '../src/serializer.js'

declare module '@adonisjs/core/types' {
  export interface ContainerBindings {
    xrpcRouter: XrpcRouter
  }
}

/**
 * Minimal XRPC provider — Plan 03 scope.
 *
 * register(): binds the XrpcRouter as a container singleton. Runs before
 * any other provider's boot(), so the binding is available by the time
 * boot() resolves it.
 *
 * boot(): resolves the XrpcRouter singleton eagerly and installs a
 * `router.xrpc` getter on `Router.prototype` via `Object.defineProperty`.
 * (The main `Router` class isn't `Macroable` in `@adonisjs/http-server@8.x`
 * — only the route sub-classes are — so `Router.macro(...)` /
 * `Router.getter(...)` aren't available; the prototype-property primitive
 * is what `Macroable.getter` wraps internally anyway.) Middleware
 * mounting is the consumer's responsibility (start/kernel.ts) or
 * setupApp's (tests) — not the provider's.
 *
 * start() (all environments): commits the XrpcRouter so further
 * `router.xrpc.*()` registrations throw. Not gated on env because Plan 06's
 * `list:xrpc:routes` ace command (and any other future console-env
 * tooling) needs to read the committed registry too.
 *
 * ready() (skips in `console` env only): constructs the atcute XRPCRouter
 * + executor + XrpcServer, container-binds, then calls `XrpcServer.start()`
 * to install routes onto atcute and wire the WS upgrade handler. Plan 04
 * expands this with `XrpcService` facade, error-reporter registration,
 * and atcute's handleException / handleSubscriptionException wiring.
 */
export default class XrpcProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton(XrpcRouter, () => new XrpcRouter(this.app))
    this.app.container.alias('xrpcRouter', XrpcRouter)
  }

  async boot() {
    // Resolve eagerly so the getter body can return synchronously —
    // `router.xrpc.procedure(...)` is called synchronously at consumer
    // route-definition time, so the getter can't hand back a Promise.
    // Router instances don't expose `app`/container themselves (their
    // `#app` field is private), so closure capture from boot() is the
    // only way to thread the resolved XrpcRouter into the getter body.
    const xrpcRouter = await this.app.container.make(XrpcRouter)

    // `configurable: true` so that re-running `boot()` across multiple
    // `setupApp()` calls in the test suite redefines the getter cleanly
    // rather than throwing `TypeError: Cannot redefine property`.
    Object.defineProperty(Router.prototype, 'xrpc', {
      get() {
        return xrpcRouter
      },
      configurable: true,
      enumerable: false,
    })
  }

  /**
   * `start()` runs between `boot()` and `ready()` in the AdonisJS provider
   * lifecycle — after all preloads have loaded (so consumer
   * `start/routes.ts` has had a chance to register XRPC routes) and before
   * the app is considered ready. This is the right semantic moment to
   * commit/seal the XrpcRouter: any further `router.xrpc.procedure(...)`
   * calls after commit() throw, which is what we want once the app is
   * about to serve traffic.
   *
   * NOT gated on env — ace commands (Plan 06's `list:xrpc:routes`, etc.)
   * run in the `console` env and need to read the canonical committed
   * registry. Preloads run in all environments by default, so the
   * XrpcRouter is fully populated by the time start() fires regardless
   * of env.
   */
  async start() {
    const xrpcRouter = await this.app.container.make('xrpcRouter')
    xrpcRouter.commit()
  }

  async ready() {
    // Skip only in `console` env. The test env still needs the XrpcServer
    // wired so functional tests can exercise the dispatch pipeline.
    if (this.app.getEnvironment() === 'console') return

    // By this point provider `start()` has already committed the XrpcRouter
    // — the executor sees the final operations map. We pass the live Map
    // reference (the executor reads from it at dispatch time); commit just
    // sealed further registration.
    const xrpcRouter = await this.app.container.make('xrpcRouter')
    const ws = createNodeWebSocket()
    const atcuteRouter = new XRPCRouter({ websocket: ws.adapter })
    const executor = createXrpcExecutor({
      operations: xrpcRouter.operations,
      serializer: new XrpcSerializer(),
    })
    const xrpcServer = new XrpcServer({
      app: this.app,
      router: atcuteRouter,
      ws,
      executor,
    })
    this.app.container.bindValue(XrpcServer, xrpcServer)

    await xrpcServer.start()
  }
}
