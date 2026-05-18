import type { XrpcConfig, XrpcProviderConfig } from './types.js'

export function defineConfig<T extends XrpcProviderConfig>(config: T): XrpcConfig {
  return {
    ...config,
  }
}
