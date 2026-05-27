/*
|--------------------------------------------------------------------------
| Lexicon type primitives and package config typing
|--------------------------------------------------------------------------
*/

import type {
  InferInput as InferSchemaInput,
  InferOutput as InferSchemaOutput,
} from '@atcute/lexicons'
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

// Schema-level inference helpers from atcute root, re-exported under
// non-colliding names so our lexicon-level InferInput / InferOutput
// (below) can use the natural names. Advanced consumers (e.g. extracting
// shapes from individual schemas inside a lexicon) reach for these.
export type { InferSchemaInput, InferSchemaOutput }

// Body-level inference helpers (re-exported as-is from atcute /validations).
// Work on `lex['input']` / `lex['output']` which are XRPCBodyParam unions.
// Useful for handler authors who want to type a body slot directly without
// going through the lexicon-level InferInput / InferOutput wrappers.
export type { InferXRPCBodyInput, InferXRPCBodyOutput }

/**
 * Infer the input body type for a lexicon's handler. Procedures carry an
 * XRPCBodyParam in `.input` (which may be a lex schema, blob, or null);
 * queries and subscriptions have no request body, so `undefined`.
 */
export type InferInput<L extends XrpcLexicon> =
  L extends XRPCProcedureMetadata<any, infer I, any, any> ? InferXRPCBodyInput<I> : undefined

/**
 * Infer the output body type for a lexicon's handler. Procedures and queries
 * each carry an XRPCBodyParam in `.output`; subscriptions stream messages
 * instead — use `MessageOf<L>` for those.
 */
export type InferOutput<L extends XrpcLexicon> =
  L extends XRPCProcedureMetadata<any, any, infer O, any>
    ? InferXRPCBodyOutput<O>
    : L extends XRPCQueryMetadata<any, infer O, any>
      ? InferXRPCBodyOutput<O>
      : never

// Extract the params shape from a lexicon. atcute lexicons declare
// `params: ObjectSchema | null`; when present, InferSchemaInput<schema>
// gives the validated shape.
export type InferParams<L extends XrpcLexicon> = L['params'] extends infer P extends BaseSchema
  ? InferSchemaInput<P>
  : null

/**
 * Discriminated union of all message variants declared by a subscription
 * lexicon. Subscription lexicons declare `message: ObjectSchema |
 * VariantSchema | null`; when present, the inferred shape is the union of
 * variant payloads (each carrying a `$type` discriminator).
 */
export type MessageOf<L extends XrpcSubscriptionLexicon> = L['message'] extends infer M extends
  BaseSchema
  ? InferSchemaInput<M>
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

// --- Adonis Router augmentation ----------------------------------------
//
// Declared here (rather than in providers/provider.ts) so the augmentation
// is visible everywhere `src/types.ts` is — including test files and
// consumer code that import package symbols transitively — without forcing
// each `router.xrpc` consumer to add a side-effect import of the provider
// just to satisfy the typechecker. The runtime install happens in the
// provider's `boot()` (see Plan 03/04); this declaration is type-only.
import type { XrpcRouter } from './router/main.ts'

declare module '@adonisjs/core/http' {
  interface Router {
    xrpc: XrpcRouter
  }
}
