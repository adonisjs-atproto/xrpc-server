import { test } from '@japa/runner'
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import { adonisRequestToWebRequest, writeWebResponseToAdonisResponse } from '../src/utils.js'

test.group('adonisRequestToWebRequest', () => {
  test('preserves URL and method', ({ assert }) => {
    const ctx = new HttpContextFactory().create()
    const req = adonisRequestToWebRequest(ctx.request, 'http://localhost')
    assert.instanceOf(req, Request)
    assert.equal(req.method, ctx.request.method() ?? 'GET')
  })

  test('forwards headers (string and array values)', ({ assert }) => {
    const ctx = new HttpContextFactory().create()
    const originalHeaders = ctx.request.headers
    ctx.request.headers = () =>
      ({
        'authorization': 'Bearer token',
        'x-multi': ['a', 'b'],
      }) as any
    try {
      const req = adonisRequestToWebRequest(ctx.request, 'http://localhost')
      assert.equal(req.headers.get('authorization'), 'Bearer token')
      assert.equal(req.headers.get('x-multi'), 'a, b')
    } finally {
      ctx.request.headers = originalHeaders
    }
  })

  test('GET / HEAD requests carry no body', ({ assert }) => {
    const ctx = new HttpContextFactory().create()
    ctx.request.method = () => 'GET'
    const req = adonisRequestToWebRequest(ctx.request, 'http://localhost')
    assert.isNull(req.body)
  })
})

test.group('writeWebResponseToAdonisResponse', () => {
  test('forwards status and headers', ({ assert }) => {
    const ctx = new HttpContextFactory().create()
    const web = new Response('hello', {
      status: 201,
      headers: { 'content-type': 'text/plain', 'etag': 'xyz' },
    })
    writeWebResponseToAdonisResponse(web, ctx.response)
    assert.equal(ctx.response.getStatus(), 201)
    assert.equal(ctx.response.getHeader('content-type'), 'text/plain')
    assert.equal(ctx.response.getHeader('etag'), 'xyz')
  })

  test('null-body responses do not call stream()', ({ assert }) => {
    const ctx = new HttpContextFactory().create()
    let streamed = false
    const originalStream = ctx.response.stream
    ctx.response.stream = () => {
      streamed = true
      return ctx.response
    }
    try {
      const web = new Response(null, { status: 204 })
      writeWebResponseToAdonisResponse(web, ctx.response)
      assert.isFalse(streamed)
    } finally {
      ctx.response.stream = originalStream
    }
  })
})
