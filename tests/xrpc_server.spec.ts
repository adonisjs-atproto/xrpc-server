import { test } from '@japa/runner'
import { AsyncLocalStorage } from 'node:async_hooks'
import { XrpcServer, createXrpcExecutor } from '../src/xrpc_server.js'
import { requestContextStore, fromHttpContext } from '../src/request_context.js'

test.group('dispatch module exports', () => {
  test('xrpc_server.ts exports XrpcServer class + createXrpcExecutor factory', ({ assert }) => {
    assert.isFunction(XrpcServer, 'XrpcServer should be a class (function)')
    assert.isFunction(createXrpcExecutor, 'createXrpcExecutor should be a function')
  })

  test('request_context.ts exports requestContextStore ALS + fromHttpContext helper', ({
    assert,
  }) => {
    assert.isFunction(fromHttpContext, 'fromHttpContext should be a function')
    assert.instanceOf(requestContextStore, AsyncLocalStorage)
  })
})
