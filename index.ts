/*
|--------------------------------------------------------------------------
| Package entrypoint — public surface
|--------------------------------------------------------------------------
*/

export { configure } from './configure.js'
export { stubsRoot } from './stubs/main.ts'
export { defineConfig } from './src/define_config.js'

// Builders
export { XrpcRouter, XrpcRoute, XrpcRouteGroup } from './src/router/index.js'

// Runtime context types
export { XrpcContext } from './src/context.js'
export { XrpcResponse } from './src/response.js'
export { XrpcStream } from './src/stream.js'

// Exception handler base class (consumer's app/exceptions/xrpc_handler.ts extends this)
export { ExceptionHandler } from './src/exception_handler.js'

// Errors (full hierarchy — all 9 subclasses)
export {
  XrpcError,
  AuthRequiredError,
  ForbiddenError,
  InvalidRequestError,
  NotFoundError,
  RateLimitExceededError,
  InternalServerError,
  UpstreamFailureError,
  NotEnoughResourcesError,
  UpstreamTimeoutError,
} from './src/errors.js'

// Types
export type {
  XrpcConfig,
  XrpcProviderConfig,
  XrpcLexicon,
  XrpcProcedureLexicon,
  XrpcQueryLexicon,
  XrpcSubscriptionLexicon,
  InferInput,
  InferParams,
  InferOutput,
  MessageOf,
  XrpcMessageRef,
  XrpcMessagePayload,
} from './src/types.js'
