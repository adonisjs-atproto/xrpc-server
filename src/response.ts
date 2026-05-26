import Macroable from '@poppinss/macroable'
import type { InferOutput, XrpcLexicon } from './types.js'

/**
 * Output channel for procedure / query handlers. Buffers response state
 * locally (status / headers / body / redirect) — the dispatch executor
 * (Plan 03) reads .state after the handler resolves and constructs the
 * wire Response (atcute's router checks output instanceof Response and
 * silently drops non-Response returns, so the executor MUST construct one).
 *
 * Macroable so plugin packages can attach declarative response methods.
 *
 * For subscriptions, this class is not used — XrpcStream lives in the same
 * ctx.response slot for that path.
 *
 * @internal — instances constructed by XrpcContext's constructor (which
 * branches on lexicon.type).
 */
export class XrpcResponse<L extends XrpcLexicon> extends Macroable {
  readonly state: {
    status?: number
    headers: Headers
    body?: InferOutput<L>
    bodySet: boolean
    redirect?: { url: string; status: 301 | 302 | 303 | 307 | 308 }
  }

  constructor() {
    super()
    this.state = { headers: new Headers(), bodySet: false }
  }

  status(code: number): this {
    this.state.status = code
    return this
  }

  header(name: string, value: string): this {
    this.state.headers.set(name, value)
    return this
  }

  json(value: InferOutput<L>): this {
    this.state.body = value
    this.state.bodySet = true
    return this
  }

  redirect(url: string, status: 301 | 302 | 303 | 307 | 308 = 302): this {
    this.state.redirect = { url, status }
    return this
  }
}
