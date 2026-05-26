import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import { BaseTransformer } from '@adonisjs/core/transformers'
import { setupApp } from './helpers.js'
import { XrpcSerializer } from '../src/serializer.js'

class UserTransformer extends BaseTransformer<{ id: number; name: string }> {
  toObject() {
    return { id: this.resource.id, name: this.resource.name }
  }
}

test.group('XrpcSerializer', (group) => {
  let app: ApplicationService

  group.each.setup(async () => {
    const result = await setupApp()
    app = result.app
    return result.terminate
  })

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
    const resolver = app.container.createResolver()
    const item = UserTransformer.transform({ id: 1, name: 'Alice' })!
    const result = await serializer.serialize(item, resolver)
    assert.deepEqual(result, { id: 1, name: 'Alice' })
  })

  test('serialize unpacks a Collection contract to an array of transformed objects', async ({
    assert,
  }) => {
    const serializer = new XrpcSerializer()
    const resolver = app.container.createResolver()
    const collection = UserTransformer.transform([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ])!
    const result = await serializer.serialize(collection, resolver)
    assert.deepEqual(result, [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ])
  })

  test('serializeWithoutWrapping behaves identically because wrap is already undefined', async ({
    assert,
  }) => {
    const serializer = new XrpcSerializer()
    const resolver = app.container.createResolver()
    const item = UserTransformer.transform({ id: 1, name: 'Alice' })!
    const wrapped = await serializer.serialize(item, resolver)
    const unwrapped = await serializer.serializeWithoutWrapping(item, resolver)
    assert.deepEqual(wrapped, unwrapped)
  })

  test('serialize passes plain objects through untouched (no transformer contract)', async ({
    assert,
  }) => {
    const serializer = new XrpcSerializer()
    const resolver = app.container.createResolver()
    const plain = { reportId: 'abc', createdAt: '2026-05-24T00:00:00Z' }
    const result = await serializer.serialize(plain, resolver)
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
    const resolver = app.container.createResolver()
    const response = {
      cursor: 'opaque-cursor-value',
      followers: UserTransformer.transform([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ])!,
    }
    const result = await serializer.serialize(response, resolver)
    assert.deepEqual(result, {
      cursor: 'opaque-cursor-value',
      followers: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
    })
  })
})
