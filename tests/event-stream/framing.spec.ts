import { test } from '@japa/runner'
import { encode } from '@atcute/cbor'
import { decodeFrame, encodeFrame, type DecodedFrame } from '../../src/event-stream/framing.js'

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

test.group('decodeFrame', () => {
  test('decodes a message frame with discriminator', ({ assert }) => {
    const buffer = concatBytes(encode({ op: 1, t: '#tick' }), encode({ n: 7 }))
    const frame = decodeFrame(buffer)
    assert.equal(frame.type, 'message')
    if (frame.type !== 'message') return
    assert.equal(frame.discriminator, '#tick')
    assert.deepEqual(frame.body, { n: 7 })
  })

  test('decodes a message frame without discriminator', ({ assert }) => {
    const buffer = concatBytes(encode({ op: 1 }), encode({ value: 'plain' }))
    const frame = decodeFrame(buffer)
    assert.equal(frame.type, 'message')
    if (frame.type !== 'message') return
    assert.isUndefined(frame.discriminator)
    assert.deepEqual(frame.body, { value: 'plain' })
  })

  test('decodes an error frame with code + message', ({ assert }) => {
    const buffer = concatBytes(
      encode({ op: -1 }),
      encode({ error: 'FutureCursor', message: 'cursor is in the future' })
    )
    const frame = decodeFrame(buffer)
    assert.equal(frame.type, 'error')
    if (frame.type !== 'error') return
    assert.equal(frame.error, 'FutureCursor')
    assert.equal(frame.message, 'cursor is in the future')
  })

  test('decodes an error frame without message', ({ assert }) => {
    const buffer = concatBytes(encode({ op: -1 }), encode({ error: 'ConsumerTooSlow' }))
    const frame = decodeFrame(buffer)
    assert.equal(frame.type, 'error')
    if (frame.type !== 'error') return
    assert.equal(frame.error, 'ConsumerTooSlow')
    assert.isUndefined(frame.message)
  })

  test('throws on invalid header op', ({ assert }) => {
    const buffer = concatBytes(encode({ op: 99 }), encode({}))
    assert.throws(() => decodeFrame(buffer), /invalid frame header/)
  })

  test('throws on non-object header', ({ assert }) => {
    const buffer = concatBytes(encode('not-an-object'), encode({}))
    assert.throws(() => decodeFrame(buffer), /invalid frame header/)
  })
})

test.group('encodeFrame', () => {
  test('round-trips a message frame with discriminator', ({ assert }) => {
    const original: DecodedFrame = { type: 'message', discriminator: '#tick', body: { n: 42 } }
    const decoded = decodeFrame(encodeFrame(original))
    assert.deepEqual(decoded, original)
  })

  test('round-trips a message frame without discriminator', ({ assert }) => {
    const original: DecodedFrame = { type: 'message', body: { plain: true } }
    const decoded = decodeFrame(encodeFrame(original))
    assert.equal(decoded.type, 'message')
    if (decoded.type !== 'message') return
    assert.isUndefined(decoded.discriminator)
    assert.deepEqual(decoded.body, { plain: true })
  })

  test('round-trips an error frame', ({ assert }) => {
    const original: DecodedFrame = { type: 'error', error: 'FutureCursor', message: 'too far' }
    const decoded = decodeFrame(encodeFrame(original))
    assert.deepEqual(decoded, original)
  })
})
