import type { XrpcLexicon } from '../types.ts'

// Inline minimal aliases for types that live in transitive deps not exposed
// under nodenext resolution from our direct dep set.
export type AnyConstructor = new (...args: any[]) => any
export type AnyLazyImport = () => Promise<{ default: AnyConstructor }>

export type XrpcHandlerInput = ((ctx: any) => any) | [AnyLazyImport | AnyConstructor, string?]

export type NormalizedHandler =
  | { kind: 'function'; fn: (ctx: any) => any }
  | {
      kind: 'controller'
      name: string
      handle: (resolver: any, ctx: any) => Promise<unknown>
    }

export interface RouteInfo {
  lexicon: XrpcLexicon
  handler: NormalizedHandler
}
