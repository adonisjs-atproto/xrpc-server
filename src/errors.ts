import { Exception } from '@poppinss/exception'

/**
 * Base class for all XRPC-domain errors. Three orthogonal name slots:
 *
 * - `name` (inherited from Error): JS class name, used for stack traces and
 *   `instanceof` discrimination.
 * - `code`: machine-readable JS-level error code, used for log filtering and
 *   error-recovery routing in the host application.
 * - `errorName`: atproto wire-format error category. Goes into the `error`
 *   field of the XRPC wire response and matches the lexicon's `errors[].name`.
 */
export class XrpcError extends Exception {
  static status = 500
  static code = 'E_XRPC_ERROR'
  static errorName = 'InternalServerError'

  get errorName(): string {
    return (this.constructor as typeof XrpcError).errorName
  }
}

export class AuthRequiredError extends XrpcError {
  static status = 401
  static code = 'E_AUTH_REQUIRED'
  static errorName = 'AuthenticationRequired'
}

export class ForbiddenError extends XrpcError {
  static status = 403
  static code = 'E_FORBIDDEN'
  static errorName = 'Forbidden'
}

export class InvalidRequestError extends XrpcError {
  static status = 400
  static code = 'E_INVALID_REQUEST'
  static errorName = 'InvalidRequest'
}

export class NotFoundError extends XrpcError {
  static status = 404
  static code = 'E_NOT_FOUND'
  static errorName = 'NotFound'
}

export class RateLimitExceededError extends XrpcError {
  static status = 429
  static code = 'E_RATE_LIMITED'
  static errorName = 'RateLimitExceeded'
}

export class InternalServerError extends XrpcError {
  static status = 500
  static code = 'E_INTERNAL_ERROR'
  static errorName = 'InternalServerError'
}

export class UpstreamFailureError extends XrpcError {
  static status = 502
  static code = 'E_UPSTREAM_FAILURE'
  static errorName = 'UpstreamFailure'
}

export class NotEnoughResourcesError extends XrpcError {
  static status = 503
  static code = 'E_NOT_ENOUGH_RESOURCES'
  static errorName = 'NotEnoughResources'
}

export class UpstreamTimeoutError extends XrpcError {
  static status = 504
  static code = 'E_UPSTREAM_TIMEOUT'
  static errorName = 'UpstreamTimeout'
}
