import Macroable from '@poppinss/macroable'
import type {
  MessageOf,
  XrpcMessagePayload,
  XrpcMessageRef,
  XrpcSubscriptionLexicon,
} from './types.js'

/**
 * Output channel for subscription handlers. The handler yields the values
 * returned from message(ref, payload); the dispatch executor (Plan 03)
 * pipes each one through the serializer before atcute frames it on the wire.
 *
 * @internal — instances constructed by dispatch.
 */
export class XrpcStream<L extends XrpcSubscriptionLexicon> extends Macroable {
  constructor(
    private lexicon: L,
    public readonly signal: AbortSignal
  ) {
    super()
  }

  get aborted(): boolean {
    return this.signal.aborted
  }

  /**
   * Build a typed message object. The return value must be yielded from the
   * subscription handler — it is not sent to the client until the executor
   * picks it up from the `AsyncIterable`.
   *
   * @example
   * yield ctx.stream.message('#labels', { seq: cursor, labels: [...] })
   */
  message<R extends XrpcMessageRef<L>>(ref: R, payload: XrpcMessagePayload<L, R>): MessageOf<L> {
    return {
      $type: `${this.lexicon.nsid}${ref}`,
      ...payload,
    } as unknown as MessageOf<L>
  }
}
