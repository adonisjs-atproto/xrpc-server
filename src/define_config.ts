import { isDid } from '@atcute/lexicons/syntax'
import { InvalidArgumentsException } from '@poppinss/exception'
import type { XrpcConfig, XrpcProviderConfig } from './types.js'

/**
 * Validates and returns the package config. Throws `InvalidArgumentsException`
 * if `serviceDid` is not a syntactically-valid DID — a bad value here would
 * otherwise surface much later as opaque service-JWT verification failures.
 *
 * Delegates the DID-syntax check to `@atcute/lexicons`'s `isDid` guard so all
 * package + consumer code agrees on what counts as a DID (resolver, JWT
 * verifier, config validator).
 *
 * The generic `T` keeps the call site's literal types intact so future config
 * fields can be inferred from the consumer's defineConfig() call.
 */
export function defineConfig<T extends XrpcProviderConfig>(config: T): T & XrpcConfig {
  if (!isDid(config.serviceDid)) {
    throw new InvalidArgumentsException(
      `defineConfig: serviceDid must be a valid DID (e.g. "did:plc:..." or "did:web:...") — got ${JSON.stringify(config.serviceDid)}`
    )
  }
  return config
}
