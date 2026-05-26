import type { Server } from 'node:http'
import type WebSocket from 'ws'
import { injectWS } from 'light-my-websocket'

import type { XrpcSubscriptionLexicon } from './types.js'
import { decodeFrame, type DecodedFrame } from './event-stream/framing.js'

// Re-export `DecodedFrame` so consumers don't need a second import path
// for the type they'll be switching on inside `messages()` iteration.
export type { DecodedFrame }

export interface InjectXrpcSubscriptionOptions {
  /** URL search params (e.g. `cursor` for subscriptions that support resumption). */
  params?: Record<string, string | number | string[]>
  /** Additional request headers. */
  headers?: Record<string, string>
}

export interface InjectedXrpcSubscription {
  /**
   * Async iterable of decoded frames. Consumers typically iterate with
   * `for await ... break` until they've observed enough — subscriptions
   * don't have a natural end, so the test decides when. Each frame is a
   * `DecodedFrame` discriminated union (`{ type: 'message' } | { type: 'error' }`).
   */
  messages(): AsyncIterable<DecodedFrame>
  /** Close the WebSocket from the client side. Resolves when fully closed. */
  close(code?: number, reason?: string): Promise<void>
  /** Underlying `ws.WebSocket` client — escape hatch for protocol-level assertions. */
  socket: WebSocket
}

/**
 * Test helper: open a synthetic WebSocket against `server` for an XRPC
 * subscription route. Constructs `/xrpc/<lexicon.nsid>?<params>`, runs the
 * synthetic-upgrade dance via `injectWS`, and returns an iterable of
 * decoded atproto frames (via `decodeFrame` from `./event-stream/framing.js`).
 *
 * Use from `tests/` only. Requires a Node `http.Server` that has been
 * attached to the Adonis server via `setNodeServer(...)` so
 * `XrpcServer.#installWebSocketHandler` had a chance to wire its
 * upgrade listener.
 */
export async function injectXrpcSubscription<L extends XrpcSubscriptionLexicon>(
  server: Server,
  lexicon: L,
  options: InjectXrpcSubscriptionOptions = {}
): Promise<InjectedXrpcSubscription> {
  const url = new URL(`/xrpc/${lexicon.nsid}`, 'http://localhost')
  for (const [k, v] of Object.entries(options.params ?? {})) {
    if (Array.isArray(v)) {
      for (const item of v) url.searchParams.append(k, String(item))
    } else {
      url.searchParams.set(k, String(v))
    }
  }

  // light-my-websocket@0.1+ Chain API: `injectWS(...)` returns a thenable
  // `WebSocketChain` synchronously. `.toIterable(decodeFrame)` queues
  // 'message' / 'close' / 'error' listeners on the chain (replayed onto the
  // real WebSocket BEFORE `setSocket()` attaches the parser — no race
  // window), then exposes an async iterable that terminates on close /
  // throws on error / detaches its listeners in a `finally` block. The
  // `await chain` triggers `.connect()` and resolves to the connected
  // WebSocket; `.toIterable(...)` itself also triggers `.connect()` if it
  // hasn't been called.
  const chain = injectWS(server, url.pathname + url.search, {
    headers: options.headers,
  })
  const iterable = chain.toIterable(decodeFrame)
  const ws = await chain

  async function close(code?: number, reason?: string): Promise<void> {
    if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) return
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
    ws.close(code, reason)
    await closed
  }

  return { messages: () => iterable, close, socket: ws }
}
