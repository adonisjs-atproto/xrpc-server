import { test } from '@japa/runner'
import { defineConfig } from '../src/define_config.js'

test.group('defineConfig — happy path', () => {
  test('returns the same object passed in (passthrough)', ({ assert }) => {
    const input = { serviceDid: 'did:plc:example' as const }
    const result = defineConfig(input)
    assert.deepEqual(result, input)
  })

  test('accepts did:plc identifiers', ({ assert }) => {
    const result = defineConfig({ serviceDid: 'did:plc:abc123xyz' })
    assert.equal(result.serviceDid, 'did:plc:abc123xyz')
  })

  test('accepts did:web identifiers with hostnames', ({ assert }) => {
    const result = defineConfig({ serviceDid: 'did:web:example.com' })
    assert.equal(result.serviceDid, 'did:web:example.com')
  })

  test('accepts did:web identifiers with ports and paths', ({ assert }) => {
    const result = defineConfig({ serviceDid: 'did:web:example.com%3A8443:user:alice' })
    assert.equal(result.serviceDid, 'did:web:example.com%3A8443:user:alice')
  })
})

test.group('defineConfig — rejects malformed serviceDid', () => {
  const badInputs: Array<[string, unknown]> = [
    ['empty string', ''],
    ['plain identifier', 'not-a-did'],
    ['missing method', 'did::example'],
    ['missing id', 'did:plc:'],
    ['uppercase method', 'did:PLC:abc'],
    ['leading whitespace', ' did:plc:abc'],
    ['trailing whitespace', 'did:plc:abc '],
    ['null value', null],
    ['number value', 123],
  ]

  for (const [label, value] of badInputs) {
    test(`rejects ${label}`, ({ assert }) => {
      assert.throws(() => defineConfig({ serviceDid: value as any }), /serviceDid/)
    })
  }
})
