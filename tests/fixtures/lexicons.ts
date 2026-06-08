/*
 * Shared test lexicons + controllers.
 *
 * All test lexicons go through atcute's `procedure` / `query` / `subscription`
 * builders so the schemas have the `~run` fastpath codegen that atcute's
 * `safeParse` requires at runtime. Plain object literals like
 * `{ type: 'xrpc_procedure', nsid: '…' }` work for type-checking but crash
 * inside `safeParse` (which calls `schema['~run']`).
 *
 * Lifted out of individual spec files so:
 *  - dispatch.spec.ts can reach for `PING` / `ECHO_QUERY` without redefining
 *  - dispatch_subscription.spec.ts can reach for `STREAM` / `CONTROLLER_STREAM`
 *  - router.spec.ts uses typed lexicons end-to-end (no `as any` stubs)
 *    when asserting the registration tuple types
 */

import {
  boolean,
  object,
  procedure,
  query,
  subscription,
  variant,
  optional,
  literal,
  integer,
  string,
} from '@atcute/lexicons/validations'

// ─── Subscription message shape ─────────────────────────────────────────
// Shared $type discriminator + message body schema. Both STREAM and
// CONTROLLER_STREAM emit messages of this shape (different NSIDs at the
// envelope level, same payload at the body level — keeps assertions simple).

export const tick = 'com.example.stream#tick' as const

export const tickSchema = object({
  $type: optional(literal(tick)),
  value: integer(),
})

// ─── HTTP lexicons ──────────────────────────────────────────────────────

export const pong = 'com.example.ping#pong' as const

export const PING = procedure('com.example.ping', {
  params: null,
  input: { type: 'lex', schema: object({}) },
  output: {
    type: 'lex',
    schema: object({
      $type: optional(literal(pong)),
      pong: boolean(),
    }),
  },
})

export const echo = 'com.example.echo#echo' as const

export const ECHO_QUERY = query('com.example.echo', {
  params: object({ msg: string() }),
  output: {
    type: 'lex',
    schema: object({
      $type: optional(literal(echo)),
      echoed: string(),
    }),
  },
})

// ─── Subscription lexicons ──────────────────────────────────────────────

export const STREAM = subscription('com.example.stream', {
  params: object({}),
  message: variant([tickSchema]),
})

// Separate NSID so dispatch_subscription.spec.ts can register both a
// function-form and a controller-form handler in the same setup without
// colliding.
export const CONTROLLER_STREAM = subscription('com.example.controller-stream', {
  params: object({}),
  message: variant([tickSchema]),
})

// ─── Controllers for [Controller, 'method'] tuple registration ──────────
// Defined at module scope: moduleCaller detects classes via
// Function.prototype.toString.call(value).startsWith('class '), which works
// for a top-level class declaration but not for one constructed inline inside
// a test closure (TS may down-emit it to a `var X = class { ... }` form that
// the regex misses).

export class StreamController {
  // Valid subscription method: returns AsyncGenerator → satisfies
  // HandlerReturnFor<XrpcSubscriptionLexicon> = AsyncIterable<MessageOf<L>>.
  async *subscribe(_ctx: any) {
    for (let n = 1; n <= 3; n++) {
      yield { $type: tick, value: n }
    }
  }

  // Intentionally bad for a subscription: returns a single value, not an
  // AsyncIterable. router.spec.ts asserts GetXrpcControllerHandlers
  // narrowing rejects this method name as a subscription handler.
  async nonSubscribe(_ctx: any) {
    return { $type: tick, value: 1 }
  }
}

export class HttpController {
  // Valid for procedure / query with output: null — returns void, which is
  // exactly what HandlerReturnFor<query|procedure> = InferOutput<L> | void
  // permits when the lexicon declares no output schema.
  async create(_ctx: any) {}

  // Intentionally bad for an HTTP route: returns AsyncGenerator, which
  // matches the subscription shape but NOT the HTTP shape. The narrowing
  // for query/procedure constrains returns to InferOutput<L> | void (no
  // AsyncIterable), so this method is filtered out of the valid handler-
  // name union.
  async *streamingCreate(_ctx: any) {
    yield { ok: true }
  }
}
