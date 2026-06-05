import { HttpContextFactory } from '@adonisjs/core/factories/http'
import type { HttpRequest } from '@adonisjs/core/http'
import type { Logger } from '@adonisjs/core/logger'
import type { ContainerResolver } from '@adonisjs/core/container'
import { XrpcContext } from '../src/context.js'
import type { XrpcLexicon, InferInput, InferParams } from '../src/types.js'

interface MergeParams<L extends XrpcLexicon> {
  lexicon: L
  request: HttpRequest
  input: unknown
  params: Record<string, any>
  signal: AbortSignal
  logger: Logger
  containerResolver: ContainerResolver<any>
  requestId: string
}

/**
 * Test-facing builder for XrpcContext. Carries sensible defaults for every
 * field — tests merge only the fields that matter for the assertion under
 * test, parallel to Adonis's HttpContextFactory. Defaults derive from a
 * fresh HttpContextFactory().create() (same source the production
 * HTTP-path materialization uses via fromHttpContext() in Plan 03), so
 * test fixtures stay aligned with real dispatch.
 */
export class XrpcContextFactory {
  #params: Partial<MergeParams<XrpcLexicon>> = {}

  merge(params: Partial<MergeParams<XrpcLexicon>>): this {
    this.#params = { ...this.#params, ...params }
    return this
  }

  create<L extends XrpcLexicon>(): XrpcContext<L> {
    const lexicon = this.#params.lexicon as L | undefined
    if (!lexicon) {
      throw new Error('XrpcContextFactory: lexicon is required — call .merge({ lexicon }) first')
    }

    const httpCtx = new HttpContextFactory().create()
    const request = this.#params.request ?? httpCtx.request
    const logger = this.#params.logger ?? httpCtx.logger
    const containerResolver = this.#params.containerResolver ?? httpCtx.containerResolver
    const requestId = this.#params.requestId ?? httpCtx.request.id() ?? 'test-req-id'
    const signal = this.#params.signal ?? new AbortController().signal

    return new XrpcContext<L>({
      lexicon,
      request,
      input: (this.#params.input as unknown as InferInput<L>) ?? (undefined as any),
      params:
        (this.#params.params as unknown as InferParams<L>) ?? ({} as unknown as InferParams<L>),
      signal,
      logger,
      containerResolver,
      requestId,
    })
  }
}
