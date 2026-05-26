import { decode, decodeFirst, encode } from '@atcute/cbor'

/**
 * Atproto event-stream frame header. Reference:
 * https://atproto.com/specs/event-stream
 *
 * - `op: 1` — message frame; `t` is the type discriminator (e.g. `'#commit'`,
 *   `'#labels'`), relative to the subscription's NSID.
 * - `op: -1` — error frame; body is `ErrorFrameBody`.
 */
export interface FrameHeader {
  op: 1 | -1
  t?: string
}

/**
 * Body shape for error frames (op = -1). `error` is the atproto error code
 * (e.g. `'FutureCursor'`); `message` is an optional human-readable detail.
 */
export interface ErrorFrameBody {
  error: string
  message?: string
}

/**
 * Discriminated-union result of decoding an atproto frame buffer. Consumers
 * `switch (frame.type)` to get TypeScript narrowing on the body shape.
 */
export type DecodedFrame =
  | { type: 'message'; body: unknown; discriminator?: string }
  | { type: 'error'; error: string; message?: string }

/**
 * Decode an atproto event-stream frame: two CBOR objects (header + body)
 * concatenated in a single binary message. Returns a `DecodedFrame` narrowed
 * by `op` (1 = message, -1 = error).
 *
 * Throws on malformed CBOR (propagated from `@atcute/cbor`) or an invalid
 * header shape (op outside {1, -1}, or `t` non-string-or-undefined).
 *
 * Atcute provides the encoding/decoding building blocks but doesn't ship a
 * high-level frame decoder — this fills the gap.
 */
export function decodeFrame(buffer: Uint8Array): DecodedFrame {
  const [header, afterHeader] = decodeFirst(buffer)
  if (!isValidHeader(header)) {
    throw new Error('invalid frame header')
  }
  const body = decode(afterHeader)
  if (header.op === 1) {
    return { type: 'message', body, discriminator: header.t }
  }
  const errorBody = body as ErrorFrameBody
  return { type: 'error', error: errorBody.error, message: errorBody.message }
}

/**
 * Encode a `DecodedFrame` back to wire bytes. Symmetric with `decodeFrame` —
 * round-trips cleanly. Use from tests to construct synthetic frames against
 * stub WebSocket servers, or from consumer code that needs to inject pre-
 * decoded messages into a pipeline.
 *
 * The package's own subscription dispatch path does NOT use this — atcute's
 * `XRPCRouter` handles frame encoding internally for subscription handlers'
 * yielded values.
 */
export function encodeFrame(frame: DecodedFrame): Uint8Array {
  if (frame.type === 'message') {
    const header = encode(frame.discriminator ? { op: 1, t: frame.discriminator } : { op: 1 })
    const body = encode(frame.body)
    return concatBytes(header, body)
  }
  const header = encode({ op: -1 })
  const body = encode(
    frame.message ? { error: frame.error, message: frame.message } : { error: frame.error }
  )
  return concatBytes(header, body)
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function isValidHeader(value: unknown): value is FrameHeader {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return (obj.op === 1 || obj.op === -1) && (obj.t === undefined || typeof obj.t === 'string')
}
