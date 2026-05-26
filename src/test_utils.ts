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

  // Buffer queue + listener registration BEFORE `injectWS` resolves. Why:
  // injectWS resolves on the WebSocket 'open' event, after the underlying
  // duplex stream has been attached. Server-side `ws.send(...)` calls fire
  // synchronously inside the upgrade handler, so by the time the consumer
  // gets the resolved ws back, messages may already be flowing — any
  // listener attached after that point misses them. `onInit` runs before
  // 'open', which is early enough.
  const queue: (Buffer | null)[] = []
  const waiters: (() => void)[] = []
  const push = (chunk: Buffer | null) => {
    queue.push(chunk)
    waiters.shift()?.()
  }
  const onMessage = (chunk: Buffer) => push(chunk)
  const onEnd = () => push(null)

  const ws = await injectWS(server, url.pathname + url.search, {
    headers: options.headers,
    onInit(socket) {
      socket.on('message', onMessage)
      socket.on('close', onEnd)
      socket.on('error', onEnd)
    },
  })

  function messages(): AsyncIterable<DecodedFrame> {
    async function* iterate() {
      try {
        while (true) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => waiters.push(resolve))
          }
          const item = queue.shift()
          if (item === null || item === undefined) return
          yield decodeFrame(item)
        }
      } finally {
        ws.off('message', onMessage)
        ws.off('close', onEnd)
        ws.off('error', onEnd)
      }
    }
    return iterate()
  }

  async function close(code?: number, reason?: string): Promise<void> {
    if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) return
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
    ws.close(code, reason)
    await closed
  }

  return { messages, close, socket: ws }
}
