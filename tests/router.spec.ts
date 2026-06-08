import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import { XrpcRouter, XrpcRoute, XrpcRouteGroup } from '../src/router/main.ts'
// CONTROLLER_STREAM and StreamController are only used in `typeof X`
// positions (to instantiate XrpcRouter.subscription's generics), but
// `typeof` requires the symbol to be in the value namespace — so they must
// be value imports even though no runtime reference exists.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CONTROLLER_STREAM,
  ECHO_QUERY,
  HttpController,
  PING,
  STREAM,
  StreamController,
} from './fixtures/lexicons.js'

function fakeApp(): ApplicationService {
  return {} as ApplicationService
}

test.group('XrpcRouter — declarations', () => {
  test('procedure / query / subscription register routes keyed by NSID', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    r.procedure(PING, async () => {})
    r.query(ECHO_QUERY, async () => {})
    r.subscription(STREAM, async function* () {})
    assert.equal(r.operations.get('com.example.ping')?.lexicon, PING)
    assert.equal(r.operations.get('com.example.echo')?.lexicon, ECHO_QUERY)
    assert.equal(r.operations.get('com.example.stream')?.lexicon, STREAM)
  })

  test('operations is a ReadonlyMap (not a plain object)', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    r.procedure(PING, async () => {})
    assert.instanceOf(r.operations, Map)
    assert.isUndefined(r.operations.get('__proto__'))
    assert.isUndefined(r.operations.get('constructor'))
    assert.isUndefined(r.operations.get('toString'))
  })

  test('procedure() returns an XrpcRoute instance', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    const route = r.procedure(PING, async () => {})
    assert.instanceOf(route, XrpcRoute)
  })

  test('inline function handler normalizes to { kind: "function" }', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    const fn = async () => {}
    r.procedure(PING, fn)
    const info = r.operations.get('com.example.ping')!
    assert.equal(info.handler.kind, 'function')
    assert.equal((info.handler as any).fn, fn, 'inline fn stored verbatim under .fn')
  })

  test('eager controller-class reference normalizes to { kind: "controller" } with a bound name', ({
    assert,
  }) => {
    const r = new XrpcRouter(fakeApp())
    class FakeController {
      async create() {}
    }
    const route = r.procedure(PING, [FakeController, 'create' as any])
    assert.instanceOf(route, XrpcRoute)
    const info = r.operations.get('com.example.ping')!
    assert.equal(info.handler.kind, 'controller')
    assert.isFunction((info.handler as any).handle, 'normalized controller handler exposes .handle')
    assert.equal(
      (info.handler as any).name,
      'FakeController.create',
      'moduleCaller sets .name to ClassName.method'
    )
  })

  test('lazy-import controller reference normalizes to { kind: "controller" }', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    class FakeController {
      async create() {}
    }
    // Pass the arrow inline (not via a `const lazy = ...` binding) so
    // `importFn.name` is '' — that's the form `() => import('./controller')`
    // takes in real consumer code. The `|| method` fallback in
    // normalizeHandler turns the empty string into 'create' so an eventual
    // xrpc:list command has a meaningful identifier to show.
    r.query(ECHO_QUERY, [async () => ({ default: FakeController }), 'create' as any])
    const info = r.operations.get('com.example.echo')!
    assert.equal(info.handler.kind, 'controller')
    assert.isFunction((info.handler as any).handle)
    assert.equal((info.handler as any).name, 'create')
  })

  test('non-function / non-array handler input is rejected at register time', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    assert.throws(
      () => r.procedure(PING, 'not-a-handler' as any),
      /must be an inline function or a \[Controller \| LazyImport, method\?\] tuple/
    )
  })

  test('registering the same NSID twice throws a duplicate-registration error', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    r.procedure(PING, async () => {})
    // Second registration on the same NSID — even with a different handler
    // shape — is rejected so route ambiguity can't sneak past dispatch.
    assert.throws(
      () => r.procedure(PING, async () => {}),
      /XRPC route already registered for NSID "com\.example\.ping"/
    )
  })
})

test.group('XrpcRouter — group', () => {
  test('group() returns an XrpcRouteGroup wrapping the inner routes', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    const group = r.group(() => {
      r.procedure(PING, async () => {})
      r.query(ECHO_QUERY, async () => {})
    })
    assert.instanceOf(group, XrpcRouteGroup)
  })

  test('group() runs its callback exactly once', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    let calls = 0
    r.group(() => {
      calls++
    })
    assert.equal(calls, 1)
  })

  test('nested group() throws RuntimeException', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    assert.throws(
      () =>
        r.group(() => {
          r.group(() => {})
        }),
      /Nested xrpc\.group\(\) is not supported/
    )
  })
})

test.group('XrpcRouter — commit', () => {
  test('commit() freezes the router; subsequent registrations throw', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    r.procedure(PING, async () => {})
    assert.isFalse(r.committed)
    r.commit()
    assert.isTrue(r.committed)
    assert.throws(
      () => r.procedure(ECHO_QUERY as any, async () => {}),
      /Cannot register XRPC routes after commit/
    )
    assert.throws(() => r.group(() => {}), /Cannot declare XRPC groups after commit/)
  })

  test('commit() is idempotent', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    r.commit()
    r.commit()
    assert.isTrue(r.committed)
  })
})

test.group('XrpcRouter — macroable', (group) => {
  // Macros attach to the class prototype, so clean up after the macro test
  // to avoid bleeding into other test files that touch the same class.
  group.teardown(() => {
    delete (XrpcRoute.prototype as any).mark
  })

  test('XrpcRouter / XrpcRoute / XrpcRouteGroup expose .macro()', ({ assert }) => {
    assert.isFunction((XrpcRouter as any).macro)
    assert.isFunction((XrpcRoute as any).macro)
    assert.isFunction((XrpcRouteGroup as any).macro)
  })

  test('a macro attached to XrpcRoute is callable on instances', ({ assert }) => {
    ;(XrpcRoute as any).macro('mark', function (this: XrpcRoute) {
      ;(this as any)._marked = true
      return this
    })
    const r = new XrpcRouter(fakeApp())
    const route = r.procedure(PING, async () => {})
    const out = (route as any).mark()
    assert.equal((out as any)._marked, true)
    assert.equal(out, route, 'macro returns the route for chaining')
  })
})

test.group('XrpcRouter — namespace-form lexicon input', () => {
  test('subscription accepts { mainSchema } namespace object', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    r.subscription({ mainSchema: STREAM }, async function* () {})
    assert.equal(r.operations.get('com.example.stream')?.lexicon, STREAM)
  })

  test('procedure accepts { mainSchema } namespace object', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    r.procedure({ mainSchema: PING }, async () => {})
    assert.equal(r.operations.get('com.example.ping')?.lexicon, PING)
  })

  test('query accepts { mainSchema } namespace object', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    r.query({ mainSchema: ECHO_QUERY }, async () => {})
    assert.equal(r.operations.get('com.example.echo')?.lexicon, ECHO_QUERY)
  })
})

test.group('XrpcRouter — handler-shape narrowing', () => {
  test('subscription accepts a controller method whose return matches the protocol', ({
    expectTypeOf,
  }) => {
    const r = new XrpcRouter(fakeApp())
    // Instantiate the generic method at the fixtures via TS 4.7+
    // instantiation-expression syntax — works on a value-derived function
    // type (which `r.subscription` is) but not on an indexed-access type
    // (`XrpcRouter['subscription']<L, T>` is a syntax error).
    type Arg = Parameters<
      typeof r.subscription<typeof CONTROLLER_STREAM, typeof StreamController>
    >[1]

    // `subscribe` returns AsyncGenerator → assignable to the registration tuple.
    expectTypeOf<[typeof StreamController, 'subscribe']>().toExtend<Arg>()
  })

  test('subscription rejects a controller method whose return does not match the protocol', ({
    expectTypeOf,
  }) => {
    const r = new XrpcRouter(fakeApp())
    type Arg = Parameters<
      typeof r.subscription<typeof CONTROLLER_STREAM, typeof StreamController>
    >[1]

    // `nonSubscribe` returns Promise<{...}> (single value, not AsyncIterable)
    // — GetXrpcControllerHandlers narrowing filters it out of the valid
    // method-name union, so the registration tuple is not assignable.
    expectTypeOf<[typeof StreamController, 'nonSubscribe']>().not.toExtend<Arg>()
  })

  test('procedure accepts a controller method whose return matches the protocol', ({
    expectTypeOf,
  }) => {
    const r = new XrpcRouter(fakeApp())
    type Arg = Parameters<typeof r.procedure<typeof PING, typeof HttpController>>[1]

    // `create` returns void → satisfies HandlerReturnFor<XrpcProcedureLexicon>
    // = InferOutput<L> | void (PING has output: null, so InferOutput is
    // never — only void remains).
    expectTypeOf<[typeof HttpController, 'create']>().toExtend<Arg>()
  })

  test('procedure rejects a controller method whose return does not match the protocol', ({
    expectTypeOf,
  }) => {
    const r = new XrpcRouter(fakeApp())
    type Arg = Parameters<typeof r.procedure<typeof PING, typeof HttpController>>[1]

    // `streamingCreate` returns AsyncGenerator — HandlerReturnFor<HTTP-L>
    // doesn't include AsyncIterable, so the narrowing filters this method
    // name out. Registering a streaming method on an HTTP procedure is the
    // mirror of registering a single-value method on a subscription.
    expectTypeOf<[typeof HttpController, 'streamingCreate']>().not.toExtend<Arg>()
  })

  test('query accepts a controller method whose return matches the protocol', ({
    expectTypeOf,
  }) => {
    const r = new XrpcRouter(fakeApp())
    type Arg = Parameters<typeof r.query<typeof ECHO_QUERY, typeof HttpController>>[1]

    expectTypeOf<[typeof HttpController, 'create']>().toExtend<Arg>()
  })

  test('query rejects a controller method whose return does not match the protocol', ({
    expectTypeOf,
  }) => {
    const r = new XrpcRouter(fakeApp())
    type Arg = Parameters<typeof r.query<typeof ECHO_QUERY, typeof HttpController>>[1]

    expectTypeOf<[typeof HttpController, 'streamingCreate']>().not.toExtend<Arg>()
  })
})

test.group('XrpcRouter — routeFor lookup', () => {
  test('returns the registered XrpcRoute for a known NSID', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    r.procedure(PING, async () => {})
    assert.instanceOf(r.routeFor('com.example.ping'), XrpcRoute)
  })

  test('returns undefined for an unknown NSID', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    assert.isUndefined(r.routeFor('com.example.nonexistent'))
  })
})
