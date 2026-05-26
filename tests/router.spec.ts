import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import { XrpcRouter, XrpcRoute, XrpcRouteGroup } from '../src/router.js'

function fakeApp(): ApplicationService {
  return {} as ApplicationService
}

const procedureLex = { nsid: 'com.example.test.proc', type: 'xrpc_procedure' } as any
const queryLex = { nsid: 'com.example.test.query', type: 'xrpc_query' } as any
const subscriptionLex = { nsid: 'com.example.test.sub', type: 'xrpc_subscription' } as any

test.group('XrpcRouter — declarations', () => {
  test('procedure / query / subscription register routes keyed by NSID', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    r.procedure(procedureLex, async () => ({}))
    r.query(queryLex, async () => ({}))
    r.subscription(subscriptionLex, async function* () {})
    assert.equal(r.operations.get('com.example.test.proc')?.lexicon, procedureLex)
    assert.equal(r.operations.get('com.example.test.query')?.lexicon, queryLex)
    assert.equal(r.operations.get('com.example.test.sub')?.lexicon, subscriptionLex)
  })

  test('operations is a ReadonlyMap (not a plain object)', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    r.procedure(procedureLex, async () => ({}))
    assert.instanceOf(r.operations, Map)
    assert.isUndefined(r.operations.get('__proto__'))
    assert.isUndefined(r.operations.get('constructor'))
    assert.isUndefined(r.operations.get('toString'))
  })

  test('procedure() returns an XrpcRoute instance', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    const route = r.procedure(procedureLex, async () => ({}))
    assert.instanceOf(route, XrpcRoute)
  })

  test('inline function handler normalizes to { kind: "function" }', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    const fn = async () => ({ ok: true })
    r.procedure(procedureLex, fn)
    const info = r.operations.get('com.example.test.proc')!
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
    const route = r.procedure(procedureLex, [FakeController, 'create' as any])
    assert.instanceOf(route, XrpcRoute)
    const info = r.operations.get('com.example.test.proc')!
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
    const lazy = async () => ({ default: FakeController })
    r.procedure(queryLex, [lazy as any, 'create' as any])
    const info = r.operations.get('com.example.test.query')!
    assert.equal(info.handler.kind, 'controller')
    assert.isFunction((info.handler as any).handle)
  })

  test('non-function / non-array handler input is rejected at register time', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    assert.throws(
      () => r.procedure(procedureLex, 'not-a-handler' as any),
      /must be an inline function or a \[Controller \| LazyImport, method\?\] tuple/
    )
  })
})

test.group('XrpcRouter — group', () => {
  test('group() returns an XrpcRouteGroup wrapping the inner routes', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    const group = r.group(() => {
      r.procedure(procedureLex, async () => ({}))
      r.query(queryLex, async () => ({}))
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
    r.procedure(procedureLex, async () => ({}))
    assert.isFalse(r.committed)
    r.commit()
    assert.isTrue(r.committed)
    assert.throws(
      () => r.procedure(queryLex as any, async () => ({})),
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
    const route = r.procedure(procedureLex, async () => ({}))
    const out = (route as any).mark()
    assert.equal((out as any)._marked, true)
    assert.equal(out, route, 'macro returns the route for chaining')
  })
})

test.group('XrpcRouter — routeFor lookup', () => {
  test('returns the registered XrpcRoute for a known NSID', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    r.procedure(procedureLex, async () => ({}))
    assert.instanceOf(r.routeFor('com.example.test.proc'), XrpcRoute)
  })

  test('returns undefined for an unknown NSID', ({ assert }) => {
    const r = new XrpcRouter(fakeApp())
    assert.isUndefined(r.routeFor('com.example.nonexistent'))
  })
})
