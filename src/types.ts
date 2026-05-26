/*
|--------------------------------------------------------------------------
| Lexicon type primitives and package config typing
|--------------------------------------------------------------------------
*/

import type { InferInput, InferOutput } from '@atcute/lexicons'
import type { AtprotoDid } from '@atcute/lexicons/syntax'
import type {
  BaseSchema,
  XRPCProcedureMetadata,
  XRPCQueryMetadata,
  XRPCSubscriptionMetadata,
  InferXRPCBodyInput,
  InferXRPCBodyOutput,
} from '@atcute/lexicons/validations'

// Lexicon-shape re-exports under our nominal names. Consumers import from
// this package without reaching into atcute. If atcute renames the upstream
// types, only this alias layer changes.
export type XrpcProcedureLexicon = XRPCProcedureMetadata
export type XrpcQueryLexicon = XRPCQueryMetadata
export type XrpcSubscriptionLexicon = XRPCSubscriptionMetadata
export type XrpcLexicon = XrpcProcedureLexicon | XrpcQueryLexicon | XrpcSubscriptionLexicon

// Schema-level inference helpers (re-exported as-is from atcute root).
// Work on BaseSchema fields like `lex['params']` or `lex['message']`.
export type { InferInput, InferOutput }

// Body-level inference helpers (re-exported as-is from atcute /validations).
// Work on `lex['input']` / `lex['output']` which are XRPCBodyParam unions.
export type { InferXRPCBodyInput, InferXRPCBodyOutput }

// Extract the params shape from a lexicon. atcute lexicons declare
// `params: ObjectSchema | null`; when present, InferInput<schema> gives
// the validated shape.
export type InferParams<L extends XrpcLexicon> = L['params'] extends infer P extends BaseSchema
  ? InferInput<P>
  : null

/**
 * Discriminated union of all message variants declared by a subscription
 * lexicon. Subscription lexicons declare `message: ObjectSchema |
 * VariantSchema | null`; when present, the inferred shape is the union of
 * variant payloads (each carrying a `$type` discriminator).
 */
export type MessageOf<L extends XrpcSubscriptionLexicon> = L['message'] extends infer M extends
  BaseSchema
  ? InferInput<M>
  : never

/**
 * Union of `#ref` discriminator suffixes declared by a subscription lexicon.
 * Derived from the `$type` field of each variant in `MessageOf<L>` — the
 * full `$type` is `<NSID><#ref>`, so we strip the NSID prefix to get the
 * `#ref` portion.
 *
 * Used by `XrpcStream.message(ref, payload)` to narrow `ref` to refs the
 * lexicon actually declares — typo-rejecting at compile time.
 */
export type XrpcMessageRef<L extends XrpcSubscriptionLexicon> =
  MessageOf<L> extends { $type: infer T extends string }
    ? T extends `${string}#${infer Ref}`
      ? `#${Ref}`
      : never
    : never

/**
 * The payload shape for a specific message ref within a subscription
 * lexicon — the matching variant of the discriminated union minus its
 * `$type` field (which `XrpcStream.message` synthesizes from the NSID + ref).
 */
export type XrpcMessagePayload<
  L extends XrpcSubscriptionLexicon,
  R extends XrpcMessageRef<L>,
> = Omit<Extract<MessageOf<L>, { $type: `${string}${R}` }>, '$type'>

/**
 * Type aliases for forward-compat. These are the surface area later plans
 * augment via declaration merging — Plan 05 (auth) will extend
 * `XrpcProviderConfig` with a `resolver` field, and Plan 03 (dispatch) will
 * surface NSID-typed helpers. v1 starts with `serviceDid` as the only
 * required field.
 */
export interface XrpcProviderConfig {
  /** The DID of this service. Becomes the `aud` claim for incoming service JWTs. */
  serviceDid: AtprotoDid
}

export type XrpcConfig = XrpcProviderConfig
