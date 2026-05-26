import Macroable from '@poppinss/macroable'
import { moduleCaller, moduleImporter } from '@adonisjs/core/container'
import { RuntimeException } from '@adonisjs/core/exceptions'
import type { ApplicationService } from '@adonisjs/core/types'
import type {
  XrpcLexicon,
  XrpcProcedureLexicon,
  XrpcQueryLexicon,
  XrpcSubscriptionLexicon,
} from '../types.ts'
import type {
  AnyConstructor,
  AnyLazyImport,
  NormalizedHandler,
  RouteInfo,
  XrpcHandlerInput,
} from './types.ts'
import { XrpcRoute } from './route.ts'
import { XrpcRouteGroup } from './group.ts'

export { XrpcRoute } from './route.ts'
export { XrpcRouteGroup } from './group.ts'
export type { XrpcHandlerInput, NormalizedHandler, RouteInfo } from './types.ts'

// Distinguish eager class constructor from lazy-import arrow. ES6 class
// declarations stringify as `class …`; arrows / plain functions don't.
const isClassRegex = /^class\s/
const isClass = (value: unknown) => {
  return typeof value === 'function' && isClassRegex.test(Function.prototype.toString.call(value))
}

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
    if (this.#operations.has(lexicon.nsid)) {
      throw new RuntimeException(`XRPC route already registered for NSID "${lexicon.nsid}"`)
    }
    const route = new XrpcRoute(lexicon.nsid)
    this.#operations.set(lexicon.nsid, { lexicon, handler: this.#normalizeHandler(handler) })
    this.#routesByNsid.set(lexicon.nsid, route)
    this.#groupContext.at(-1)?.routes.push(route)
    return route
  }

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
      ? moduleCaller(refOrLazy as AnyConstructor, method).toHandleMethod()
      : moduleImporter(refOrLazy as AnyLazyImport, method).toHandleMethod()
    return {
      kind: 'controller',
      name: m.name ?? method,
      handle: m.handle as (resolver: any, ctx: any) => Promise<unknown>,
    }
  }

  get committed(): boolean {
    return this.#committed
  }

  get operations(): ReadonlyMap<string, RouteInfo> {
    return this.#operations
  }

  routeFor(nsid: string): XrpcRoute | undefined {
    return this.#routesByNsid.get(nsid)
  }

  commit(): void {
    if (this.#committed) return
    this.#committed = true
  }
}
