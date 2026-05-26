import { BaseSerializer } from '@adonisjs/core/transformers'

/**
 * The package's internal serializer for XRPC response bodies. Extends
 * `BaseSerializer` (re-exported from `@adonisjs/core/transformers`) to
 * unpack transformer contracts (`Item` / `Collection` / `Paginator`) that
 * consumer handlers embed into their return value, before atcute frames
 * the result onto the wire (JSON for procedure/query; CBOR for subscription
 * messages).
 *
 * Two design choices vs. the default serializer shape:
 *
 * - `wrap = undefined` — XRPC wire format is `InferOutput<L>` bare; there's
 *   no `data` envelope key. The lexicon's output schema is the contract.
 * - `definePaginationMetaData` is the identity function — the package has no
 *   opinion on what pagination meta should look like; the lexicon's output
 *   schema (e.g. `cursor: string`) is the source of truth, and the consumer's
 *   transformer / handler is responsible for producing that shape.
 *
 * Consumers who need to customize either can extend this class and pass
 * the subclass via `defineConfig({ serializer: MyXrpcSerializer })` once
 * Plan 04 lands the config slot.
 */
export class XrpcSerializer extends BaseSerializer<{
  PaginationMetaData: Record<string, any>
}> {
  wrap = undefined as undefined

  definePaginationMetaData(metaData: unknown): Record<string, any> {
    return metaData as Record<string, any>
  }
}
