import { XRPCSubscriptionError } from '@atcute/xrpc-server'
import {
  type XrpcContext,
  XrpcHttpContext,
  XrpcOperationContext,
  XrpcSubscriptionContext,
} from './context/main.ts'
import { InternalServerError, XrpcError } from './errors.ts'
import { type HandlerReturnFromCtx, type RouteInfo } from './router/types.ts'
import { type XrpcSerializer } from './serializer.ts'
import { type XrpcService, REPORTED } from './xrpc_service.ts'
import { type RequestContext } from './request_context.ts'
import type {
  MessageOf,
  XrpcLexicon,
  XrpcProcedureLexicon,
  XrpcQueryLexicon,
  XrpcSubscriptionLexicon,
} from './types.ts'

/**
 * The shared executor signature — one function per package instance,
 * registered with atcute for every route. The HTTP path returns a `Response`:
 * atcute's `XRPCRouter` checks `output instanceof Response` and silently
 * substitutes `new Response(null)` for non-Response returns, so the executor
 * MUST construct a Response itself — see Task 3's body for the conversion
 * from `xrpcCtx.response.state` + serialized body. The subscription path
 * returns an `AsyncIterable` of messages, which atcute iterates with
 * `for await` for frame encoding.
 */
export type SharedXrpcExecutor = (
  atcuteCtx: any,
  requestCtx?: RequestContext
) => Promise<Response> | AsyncIterable<unknown>

export function createXrpcExecutor(deps: {
  operations: ReadonlyMap<string, RouteInfo>
  serializer: XrpcSerializer
  xrpc: XrpcService
}): SharedXrpcExecutor {
  const { operations, serializer, xrpc } = deps

  // NOTE: this is intentionally a non-async function. Subscription routes
  // need to return an `AsyncIterable<unknown>` *directly* — atcute's
  // `for await (const message of handler(context))` doesn't unwrap a Promise.
  // HTTP routes return `Promise<Response>` from `XrpcOperationContext.als.run(...)`.
  return (atcuteCtx, requestCtx) => {
    // `requestCtx` arrives materialized — by the HTTP dispatch middleware on
    // the procedure/query path, by `#installWebSocketHandler` on the WS path.
    // The registered atcute closure reads `requestContextStore.getStore()`
    // and passes it through. No ALS read inside the executor.
    //
    // The parameter is typed optional (`requestCtx?`) so the registered
    // closure doesn't need a non-null assertion at the call site. If
    // `getStore()` returns undefined here, a dispatch boundary failed to
    // populate the store — surface a precise diagnostic instead of a
    // downstream `undefined.requestId` TypeError.
    if (!requestCtx) {
      throw new InternalServerError(
        'XRPC executor invoked without a RequestContext — the dispatch boundary failed to populate requestContextStore'
      )
    }

    // Re-derive NSID from URL — atcute parses the NSID internally for route
    // lookup but doesn't expose it on the operation context. Slice matches
    // atcute's own internal slice (`/xrpc/`.length). `operations` is a
    // `ReadonlyMap`, so `operations.get('__proto__')` returns `undefined`
    // cleanly even on a crafted URL — no prototype-pollution lookup risk.
    const nsid = new URL(atcuteCtx.request.url).pathname.slice('/xrpc/'.length)
    const route = operations.get(nsid)
    if (!route) {
      // This branch is for TypeScript type-narrowing on Map.get's `T |
      // undefined` return, NOT a real not-found case. In normal operation
      // atcute's `handleNotFound` hook (wired in providers/provider.ts)
      // intercepts unregistered NSIDs and produces the 404 NotFound
      // response — atcute never dispatches to this closure for those.
      // If this branch DOES fire, it means atcute dispatched to us for an
      // NSID we don't know about — a registry desync or a crafted URL that
      // snuck past atcute's matcher. That's a server bug, not a client
      // error, so InternalServerError is the correct wire shape.
      throw new InternalServerError(
        `XRPC executor invoked for unregistered NSID '${nsid}' — atcute's handleNotFound should have intercepted; treat as a registry-state bug`
      )
    }

    // Async so both branches collapse to a single Promise return:
    //   - function path: user-supplied fn may be sync or async — the outer
    //     `async` flattens either shape into a Promise.
    //   - controller path: fold's `toHandleMethod` produces an always-async
    //     `handle` that awaits `resolver.make` before invoking the method,
    //     so it always returns a Promise regardless of the method's signature.
    // The Ctx generic + HandlerReturnFromCtx<Ctx> give callers a precise
    // return type derived from the context they pass — subscription Ctx →
    // Promise<AsyncIterable<MessageOf<L>>>; HTTP Ctx → Promise<InferOutput<L>
    // | void>. No more Promise<unknown> leaking downstream.
    //
    // Two casts live inside:
    //   1. wideCtx cast — Ctx (specific subclass) → XrpcContext<XrpcLexicon>
    //      (the distributed union that NormalizedHandler.fn/.handle expects).
    //      Same wide-L vs distributed-L mismatch we hit at the construction
    //      sites; runtime-equivalent, type-system-incomparable.
    //   2. return cast — the handler's actual return type is
    //      HandlerReturnFor<any> (because RouteInfo.handler is
    //      NormalizedHandler<any> — L is erased at storage in the operations
    //      Map). That distributes to a union of every possible handler return
    //      shape (void | object | Blob | AsyncIterable<any>), which TS can't
    //      narrow back to the specific HandlerReturnFromCtx<Ctx> the caller
    //      expects. The cast acknowledges that route.lexicon.type narrowing
    //      at the call site is what actually pairs the right handler with the
    //      right Ctx — a runtime invariant the type system can't follow
    //      through the Map<string, RouteInfo> erasure.
    const invokeHandler = async <
      Ctx extends
        | XrpcHttpContext<XrpcQueryLexicon | XrpcProcedureLexicon>
        | XrpcSubscriptionContext<XrpcSubscriptionLexicon>,
    >(
      ctx: Ctx
    ): Promise<HandlerReturnFromCtx<Ctx>> => {
      const wideCtx = ctx as XrpcContext<XrpcLexicon>
      const result =
        route.handler.kind === 'function'
          ? await route.handler.fn(wideCtx)
          : await route.handler.handle(wideCtx.containerResolver, wideCtx)
      return result as HandlerReturnFromCtx<Ctx>
    }

    // Subscription path: DO NOT wrap the iterable's iteration in als.run here.
    // Async generators capture context at each `.next()` call, not at
    // construction. Returning the iterable out of `als.run` would put each
    // future `.next()` resumption in atcute's context (no store) — verified
    // empirically (Node 26). Instead, `wrapSubscriptionIterator` takes
    // `xrpcCtx` and re-enters the scope on each inner `.next()`.
    if (route.lexicon.type === 'xrpc_subscription') {
      const xrpcCtx = new XrpcSubscriptionContext({
        requestId: requestCtx.requestId,
        request: requestCtx.request,
        logger: requestCtx.logger,
        containerResolver: requestCtx.containerResolver,
        lexicon: route.lexicon,
        params: atcuteCtx.params,
        signal: atcuteCtx.signal,
      })
      // No cast: HandlerReturn<XrpcSubscriptionContext<L>> resolves to
      // AsyncIterable<MessageOf<L>>, so invokeHandler returns the right
      // Promise type directly.
      const iterablePromise = XrpcOperationContext.als.run(xrpcCtx, () => invokeHandler(xrpcCtx))
      return wrapSubscriptionIterator(iterablePromise, xrpcCtx, xrpc, serializer)
    }

    // HTTP path: enter the XrpcOperationContext ALS scope and await the
    // handler. The `await` continuations re-enter the scope on each microtask
    // boundary, so downstream code calling `XrpcHttpContext.getOrFail()` works
    // as expected.
    const xrpcCtx = new XrpcHttpContext<XrpcProcedureLexicon | XrpcQueryLexicon>({
      requestId: requestCtx.requestId,
      request: requestCtx.request,
      logger: requestCtx.logger,
      containerResolver: requestCtx.containerResolver,
      lexicon: route.lexicon as XrpcQueryLexicon | XrpcProcedureLexicon,
      input: 'input' in atcuteCtx ? atcuteCtx.input : undefined,
      params: atcuteCtx.params,
      signal: atcuteCtx.signal,
    })

    return XrpcOperationContext.als.run(xrpcCtx, async () => {
      try {
        // No cast: invokeHandler's Ctx constraint now accepts the wide-L
        // XrpcHttpContext<query|procedure> form directly. The return type
        // resolves to InferOutput<query|procedure> | void via HandlerReturn.
        const result = await invokeHandler(xrpcCtx)

        // atcute's router (verified against `xrpc-server/lib/main/router.ts`
        // on trunk, addQuery + addProcedure) inspects the handler's return
        // value with `output instanceof Response` and silently falls back to
        // `new Response(null)` for non-Response returns. We construct the
        // Response here so clients receive the actual serialized body.
        const respState = xrpcCtx.response.state

        if (respState.redirect) {
          return Response.redirect(respState.redirect.url, respState.redirect.status)
        }

        // `.json(value)` override wins over the handler's return value.
        // The handler may have called .json() and then continued doing
        // post-response work (e.g. queueing a job) before returning void —
        // `bodySet` (not `body !== undefined`) is the discriminator so
        // `.json(null)` differs from "never called".
        const rawBody = respState.bodySet ? respState.body : result
        const serialized = await serializer.serializeWithoutWrapping(
          rawBody,
          xrpcCtx.containerResolver
        )
        return Response.json(serialized, {
          status: respState.status ?? 200,
          headers: respState.headers,
        })
      } catch (err: any) {
        throw await runConsumerHandler(xrpc, err, xrpcCtx)
      }
    })
  }
}

/**
 * Run the consumer's registered ExceptionHandler against an error. Used
 * by both the procedure/query executor catch and the subscription wrapper
 * catch — single source of truth for the report → handle → mark sequence.
 *
 * Returns the XrpcError the caller should throw. Stamps the `REPORTED`
 * symbol so atcute's HTTP-path `handleException` hook (Plan 04 Task 4's
 * `makeAtcuteHttpHook`) skips a duplicate handler invocation when the
 * sanitized error bubbles up to atcute's exception handler.
 *
 * Fallback (no handler registered): wrap non-XrpcError as
 * InternalServerError with `{ cause }` — preserves the Plan 03 default
 * for tests and consumers who haven't wired `start/kernel.ts` yet.
 *
 * Param type is XrpcOperationContext (non-generic) — only reads shared
 * fields (logger) that live on the base.
 */
async function runConsumerHandler(
  xrpc: XrpcService,
  err: unknown,
  xrpcCtx: XrpcOperationContext
): Promise<XrpcError> {
  const handler = await xrpc.getRegisteredErrorHandler()

  if (handler) {
    // Reporting first — fire-and-forget for the wire response. A reporter
    // that throws gets logged but doesn't mask the original error.
    if (handler.shouldReport(err)) {
      try {
        await handler.report(err, xrpcCtx)
      } catch (reportErr) {
        xrpcCtx.logger.error(
          { err: reportErr },
          'XRPC ExceptionHandler.report() itself threw — proceeding with handle()'
        )
      }
    }

    // Sanitization — the returned XrpcError is what gets wire-encoded.
    const sanitized = await handler.handle(err, xrpcCtx)
    ;(sanitized as any)[REPORTED] = true
    return sanitized
  }

  // No handler registered — fall back to the Plan 03 default wrap.
  const fallback =
    err instanceof XrpcError
      ? err
      : new InternalServerError(err instanceof Error ? err.message : String(err), { cause: err })
  ;(fallback as any)[REPORTED] = true
  return fallback
}

/**
 * Wraps a user-provided async-generator subscription handler with a
 * transforming generator that:
 *
 * 1. Re-enters the `XrpcOperationContext.als` scope on every inner `.next()` call so
 *    downstream code calling `XrpcSubscriptionContext.getOrFail()` from inside yields
 *    sees the current context. Async generators capture context at `.next()`
 *    time (NOT at construction); a one-shot `als.run` around iterator
 *    construction doesn't propagate.
 * 2. Pipes each yielded value through the XRPC serializer (so transformer
 *    contracts the user embedded — `Item` / `Collection` — get unpacked
 *    before atcute's framing layer encodes the message as a CBOR frame).
 *
 * On error, `XrpcError` instances are translated to `XRPCSubscriptionError`
 * so atcute's `handleSubscriptionException` hook emits the error frame and
 * closes the stream cleanly.
 */
async function* wrapSubscriptionIterator<L extends XrpcSubscriptionLexicon>(
  iterable: Promise<AsyncIterable<MessageOf<L>>>,
  xrpcCtx: XrpcSubscriptionContext<L>,
  xrpc: XrpcService,
  serializer: XrpcSerializer
): AsyncGenerator<MessageOf<L>> {
  // The executor's subscription branch narrows on route.lexicon.type and
  // casts at that call site, so we receive a Promise that resolves to an
  // AsyncIterable<MessageOf<L>> here — no internal cast, result.value is
  // typed as the discriminated message union.
  const resolved = await iterable
  const inner = resolved[Symbol.asyncIterator]()
  try {
    while (true) {
      // Each .next() runs inside the XrpcOperationContext ALS scope. The user's
      // generator body resumes inside this scope and any downstream
      // `XrpcSubscriptionContext.getOrFail()` call sees `xrpcCtx`. Async generators
      // capture context at .next() time, not construction.
      const result = await XrpcOperationContext.als.run(xrpcCtx, () => inner.next())
      if (result.done) return
      // Serialization doesn't need to read XrpcOperationContext via the ALS,
      // so it stays outside the scope — keeps the scope window tight to just
      // handler execution. Cast: the serializer's static return type unpacks
      // Transformer / Paginator contracts (UnpackKeyValue, etc.) which
      // doesn't structurally match MessageOf<L>, even though at runtime the
      // output IS a valid MessageOf<L> shape for non-transformer messages.
      yield (await serializer.serializeWithoutWrapping(
        result.value,
        xrpcCtx.containerResolver
      )) as MessageOf<L>
    }
  } catch (err: any) {
    const xrpcError = await runConsumerHandler(xrpc, err, xrpcCtx)

    // Translate XrpcError → XRPCSubscriptionError. Atcute has no
    // configurable subscription-error hook — it inspects the thrown value:
    // XRPCSubscriptionError → emit error frame + close with err.closeCode;
    // anything else → close 1011 + invoke onSocketError (telemetry-only).
    // The sanitized XrpcError from runConsumerHandler carries the wire-
    // shape `errorName` + `message` we want for the error frame.
    throw new XRPCSubscriptionError({
      error: xrpcError.errorName,
      message: xrpcError.message,
    })
  }
}
