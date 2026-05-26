import { test } from '@japa/runner'
import {
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
} from '../src/errors.js'

test.group('XrpcError', () => {
  test('XrpcError defaults: status 500, code E_XRPC_ERROR, errorName InternalServerError', ({
    assert,
  }) => {
    const err = new XrpcError('boom')
    assert.equal(err.message, 'boom')
    assert.equal(XrpcError.status, 500)
    assert.equal(XrpcError.code, 'E_XRPC_ERROR')
    assert.equal(XrpcError.errorName, 'InternalServerError')
    assert.equal(err.errorName, 'InternalServerError')
  })

  test('subclasses each pin status / code / errorName', ({ assert }) => {
    const cases: Array<{
      cls: typeof XrpcError
      status: number
      code: string
      errorName: string
    }> = [
      {
        cls: AuthRequiredError,
        status: 401,
        code: 'E_AUTH_REQUIRED',
        errorName: 'AuthenticationRequired',
      },
      { cls: ForbiddenError, status: 403, code: 'E_FORBIDDEN', errorName: 'Forbidden' },
      {
        cls: InvalidRequestError,
        status: 400,
        code: 'E_INVALID_REQUEST',
        errorName: 'InvalidRequest',
      },
      { cls: NotFoundError, status: 404, code: 'E_NOT_FOUND', errorName: 'NotFound' },
      {
        cls: RateLimitExceededError,
        status: 429,
        code: 'E_RATE_LIMITED',
        errorName: 'RateLimitExceeded',
      },
      {
        cls: InternalServerError,
        status: 500,
        code: 'E_INTERNAL_ERROR',
        errorName: 'InternalServerError',
      },
      {
        cls: UpstreamFailureError,
        status: 502,
        code: 'E_UPSTREAM_FAILURE',
        errorName: 'UpstreamFailure',
      },
      {
        cls: NotEnoughResourcesError,
        status: 503,
        code: 'E_NOT_ENOUGH_RESOURCES',
        errorName: 'NotEnoughResources',
      },
      {
        cls: UpstreamTimeoutError,
        status: 504,
        code: 'E_UPSTREAM_TIMEOUT',
        errorName: 'UpstreamTimeout',
      },
    ]
    for (const { cls, status, code, errorName } of cases) {
      assert.equal(cls.status, status, `${cls.name}.status`)
      assert.equal(cls.code, code, `${cls.name}.code`)
      assert.equal(cls.errorName, errorName, `${cls.name}.errorName`)
      const instance = new cls('x')
      assert.equal(instance.errorName, errorName, `${cls.name}#errorName`)
      assert.instanceOf(instance, XrpcError, `${cls.name} extends XrpcError`)
    }
  })

  test('Error.cause is preserved when passed in options', ({ assert }) => {
    const cause = new Error('underlying')
    const err = new InvalidRequestError('wrapper', { cause })
    assert.equal(err.cause, cause)
  })
})
