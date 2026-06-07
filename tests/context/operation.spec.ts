import { test } from '@japa/runner'
import { AsyncLocalStorage } from 'node:async_hooks'
import { XrpcOperationContext } from '../../src/context/operation.ts'

test.group('XrpcOperationContext — static surface', () => {
  test('exposes an AsyncLocalStorage instance', ({ assert }) => {
    assert.instanceOf(XrpcOperationContext.als, AsyncLocalStorage)
  })

  test('get() returns undefined outside any als.run scope', ({ assert }) => {
    assert.isUndefined(XrpcOperationContext.get())
  })

  test('getOrFail() throws outside any als.run scope', ({ assert }) => {
    assert.throws(() => XrpcOperationContext.getOrFail(), /XrpcOperationContext is not available/)
  })

  test('exposes static .macro from Macroable', ({ assert }) => {
    assert.isFunction((XrpcOperationContext as any).macro)
  })
})
