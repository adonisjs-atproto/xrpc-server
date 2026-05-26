import { test } from '@japa/runner'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { encode } from '@atcute/cbor'
import { subscription, object } from '@atcute/lexicons/validations'

import { injectXrpcSubscription } from '../src/test_utils.js'

const STREAM_LEX = subscription('com.example.stream', {
  params: object({}),
  message: null,
})

test.group('injectXrpcSubscription', () => {
  test('constructs /xrpc/<nsid>?<params> URL from the lexicon + options', async ({ assert }) => {
    let observedUrl = ''
    const wss = new WebSocketServer({ noServer: true })
    const server = createServer()
    server.on('upgrade', (req, socket, head) => {
      observedUrl = req.url || ''
      wss.handleUpgrade(req, socket, head, (ws) => ws.close())
    })

    const stream = await injectXrpcSubscription(server, STREAM_LEX as any, {
      params: { cursor: 42 },
    })
    await stream.close()

    assert.equal(observedUrl, '/xrpc/com.example.stream?cursor=42')
  })

  test('decodes atproto frames (header + body CBOR) and yields typed messages', async ({
    assert,
  }) => {
    const wss = new WebSocketServer({ noServer: true })
    const server = createServer()
    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const header = encode({ op: 1, t: '#tick' })
        ws.send(Buffer.concat([header, encode({ n: 7 })]))
        ws.send(Buffer.concat([header, encode({ n: 8 })]))
        ws.close()
      })
    })

    const stream = await injectXrpcSubscription(server, STREAM_LEX as any)
    const collected = await Array.fromAsync(stream.messages())

    assert.lengthOf(collected, 2)
    assert.equal(collected[0].type, 'message')
    if (collected[0].type === 'message') {
      assert.equal(collected[0].discriminator, '#tick')
      assert.deepEqual(collected[0].body, { n: 7 })
    }
    assert.equal(collected[1].type, 'message')
    if (collected[1].type === 'message') {
      assert.equal(collected[1].discriminator, '#tick')
      assert.deepEqual(collected[1].body, { n: 8 })
    }
  })
})
