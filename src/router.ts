import Macroable from '@poppinss/macroable'
import { moduleCaller, moduleImporter } from '@adonisjs/core/container'
import { RuntimeException } from '@adonisjs/core/exceptions'
import type { ApplicationService } from '@adonisjs/core/types'
import type {
  XrpcLexicon,
  XrpcProcedureLexicon,
  XrpcQueryLexicon,
  XrpcSubscriptionLexicon,
} from './types.js'

// Inline minimal aliases for types that live in transitive deps not exposed
// under nodenext resolution from our direct dep set.
type AnyConstructor = new (...args: any[]) => any
type AnyLazyImport = () => Promise<{ default: AnyConstructor }>

export type XrpcHandlerInput =
  | ((ctx: any) => any)
  | [AnyLazyImport | AnyConstructor, string?]

export type NormalizedHandler =
  | { kind: 'function'; fn: (ctx: any) => any }
  | {
      kind: 'controller'
      name: string
      handle: (resolver: any, ctx: any) => Promise<unknown>
    }

export interface RouteInfo {
  lexicon: XrpcLexicon
  handler: NormalizedHandler
}

export class XrpcRoute extends Macroable {
  constructor(public nsid: string) {
    super()
  }
}

export class XrpcRouteGroup extends Macroable {
  constructor(public routes: XrpcRoute[]) {
    super()
  }
}

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
