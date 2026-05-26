import { test } from '@japa/runner'
import { BaseTransformer } from '@adonisjs/core/transformers'
import { XrpcSerializer } from '../src/serializer.js'

class FixtureTransformer extends BaseTransformer<{ id: number; name: string }> {
  toObject() {
    return { id: this.resource.id, name: this.resource.name }
  }
}

test.group('XrpcSerializer', () => {
  test('wrap is undefined (XRPC has no envelope key)', ({ assert }) => {
    const serializer = new XrpcSerializer()
    assert.equal(serializer.wrap, undefined)
  })

  test('definePaginationMetaData returns the input unchanged (identity)', ({ assert }) => {
    const serializer = new XrpcSerializer()
    const meta = { cursor: 'abc', limit: 50 }
    assert.strictEqual(serializer.definePaginationMetaData(meta), meta)
  })

  test('serialize unpacks an Item contract to the transformed object', async ({ assert }) => {
    const serializer = new XrpcSerializer()
    const item = FixtureTransformer.transform({ id: 1, name: 'Alice' })!
    const result = await serializer.serialize(item)
    assert.deepEqual(result, { id: 1, name: 'Alice' })
  })

  test('serialize unpacks a Collection contract to an array of transformed objects', async ({
    assert,
  }) => {
    const serializer = new XrpcSerializer()
    const collection = FixtureTransformer.transform([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ])!
    const result = await serializer.serialize(collection)
    assert.deepEqual(result, [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ])
  })

  test('serializeWithoutWrapping behaves identically because wrap is already undefined', async ({
    assert,
  }) => {
    const serializer = new XrpcSerializer()
    const item = FixtureTransformer.transform({ id: 1, name: 'Alice' })!
    const wrapped = await serializer.serialize(item)
    const unwrapped = await serializer.serializeWithoutWrapping(item)
    assert.deepEqual(wrapped, unwrapped)
  })

  test('serialize passes plain objects through untouched (no transformer contract)', async ({
    assert,
  }) => {
    const serializer = new XrpcSerializer()
    const plain = { reportId: 'abc', createdAt: '2026-05-24T00:00:00Z' }
    const result = await serializer.serialize(plain)
    assert.deepEqual(result, plain)
  })

  test('serialize unpacks a Collection nested in atproto-canonical paginated shape', async ({
    assert,
  }) => {
    // atproto's paginated XRPC convention is a flat output body:
    // `{ cursor?: string, <pluralized-field-name>: [...] }` — e.g.
    // `app.bsky.graph.getFollowers` returns `{ cursor, followers }`,
    // `app.bsky.feed.getFeedSkeleton` returns `{ cursor, feed }`, etc.
    // (See atproto.com/guides/lexicon-style-guide#design-patterns.)
    // Consumers embed a Collection contract for the array field directly
    // inside that flat shape; they do NOT use the @adonisjs/http-transformers
    // Paginator contract, whose default `{ data, meta }` shape doesn't match
    // any atproto lexicon's output schema.
    const serializer = new XrpcSerializer()
    const response = {
      cursor: 'opaque-cursor-value',
      followers: FixtureTransformer.transform([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ])!,
    }
    const result = await serializer.serialize(response)
    assert.deepEqual(result, {
      cursor: 'opaque-cursor-value',
      followers: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
    })
  })
})
