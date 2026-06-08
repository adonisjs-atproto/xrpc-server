import Macroable from '@poppinss/macroable'
import { moduleCaller, moduleImporter } from '@adonisjs/core/container'
import { RuntimeException } from '@adonisjs/core/exceptions'
import type { ApplicationService } from '@adonisjs/core/types'
import type {
  XrpcLexicon,
  LexiconInput,
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
import type { XrpcContext } from '../context/main.ts'
import { XrpcRoute } from './route.ts'
import { XrpcRouteGroup } from './group.ts'

export { XrpcRoute } from './route.ts'
export { XrpcRouteGroup } from './group.ts'
export type { XrpcHandlerInput, NormalizedHandler, RouteInfo } from './types.ts'

// Namespace objects from @atcute/atproto expose the lexicon under .mainSchema;
// plain lexicon schemas (XRPCSubscriptionMetadata etc.) carry nsid/type/params
// but have no mainSchema property. `in` is the safe runtime discriminant.
function resolveLexicon<L extends XrpcLexicon>(input: LexiconInput<L>): L {
  return 'mainSchema' in input ? (input as { readonly mainSchema: L }).mainSchema : (input as L)
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

  procedure<L extends XrpcProcedureLexicon>(
    lexicon: LexiconInput<L>,
    handler: XrpcHandlerInput<L>
  ): XrpcRoute {
    return this.#register(resolveLexicon(lexicon), handler)
  }

  query<L extends XrpcQueryLexicon>(
    lexicon: LexiconInput<L>,
    handler: XrpcHandlerInput<L>
  ): XrpcRoute {
    return this.#register(resolveLexicon(lexicon), handler)
  }

  subscription<L extends XrpcSubscriptionLexicon>(
    lexicon: LexiconInput<L>,
    handler: XrpcHandlerInput<L>
  ): XrpcRoute {
    return this.#register(resolveLexicon(lexicon), handler)
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

  #register<L extends XrpcLexicon>(lexicon: L, handler: XrpcHandlerInput<L>): XrpcRoute {
    if (this.#committed) {
      throw new RuntimeException('Cannot register XRPC routes after commit')
    }
    if (this.#operations.has(lexicon.nsid)) {
      throw new RuntimeException(`XRPC route already registered for NSID "${lexicon.nsid}"`)
    }
    const route = new XrpcRoute(lexicon.nsid)
    // NormalizedHandler<L> is stored in the wider Map<string, RouteInfo> (L
    // erased at storage). The executor narrows on lexicon.type at dispatch
    // time, so the per-route L is recovered structurally.
    // Cast: NormalizedHandler<L> → NormalizedHandler<any>. The map erases
    // L at storage; we'd hope `any`'s bivariance accepts L-typed handlers
    // directly, but XrpcContext<any> distributes to a concrete union that
    // isn't a supertype of the per-route XrpcContext<L>, so the assignment
    // is still rejected. Two-step `as unknown` cast acknowledges the round-
    // trip — the executor recovers the shape via lexicon.type narrowing.
    this.#operations.set(lexicon.nsid, {
      lexicon,
      handler: this.#normalizeHandler<L>(handler) as unknown as NormalizedHandler<any>,
    })
    this.#routesByNsid.set(lexicon.nsid, route)
    this.#groupContext.at(-1)?.routes.push(route)
    return route
  }

  #normalizeHandler<L extends XrpcLexicon>(handler: XrpcHandlerInput<L>): NormalizedHandler<L> {
    if (typeof handler === 'function') {
      return { kind: 'function', fn: handler }
    }
    if (!Array.isArray(handler)) {
      throw new RuntimeException(
        'XRPC handler must be an inline function or a [Controller | LazyImport, method?] tuple'
      )
    }
    const [refOrLazy, method = 'handle'] = handler

    // Parameterize toHandleMethod's Args generic to [XrpcContext<L>] so
    // `m.handle` types its 2nd arg as the lexicon-specific concrete context
    // subclass instead of the default `...args: any[]`. The executor invokes
    // handle with exactly (resolver, ctx), supplying the per-request
    // containerResolver; the runtime ctx is the matching concrete subclass
    // (selected by route.lexicon.type narrowing), though at the executor's
    // call site the static type is the wider XrpcContext<XrpcLexicon> because
    // L is erased to the union when the handler is stored in the operations
    // map. The T generic for the container passed to toHandleMethod is
    // undefined, as we pass the container resolver at runtime not at load
    // time.
    const m = isClass(refOrLazy)
      ? moduleCaller(refOrLazy as AnyConstructor, method).toHandleMethod<
          undefined,
          [XrpcContext<L>]
        >()
      : moduleImporter(refOrLazy as AnyLazyImport, method).toHandleMethod<
          undefined,
          [XrpcContext<L>]
        >()
    return {
      kind: 'controller',
      name: m.name ?? method,
      handle: m.handle,
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
