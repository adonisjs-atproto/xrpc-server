# Adonis.js AT Protocol XRPC Service Package

This package provides a small [Adonis.js](https://adonisjs.com) adapter for building [AT Protocol](https://atproto.com) XRPC services.

## Installation

```sh
node ace add @thisismissem/adonisjs-atproto-xrpc
```

### Configuring

If you didn't use `node ace add` you can later run the configuration using:

```sh
node ace configure @thisismissem/adonisjs-atproto-xrpc
```

## Pagination

XRPC paginated queries follow an atproto-canonical flat shape: an optional opaque `cursor` plus an array under a pluralized field name that comes from the lexicon (`followers`, `feed`, `posts`, …). For example:

```json
{
  "cursor": "NjU7Y3JlYXRlZEF0Cg",
  "followers": [{ "did": "did:example:1" }, { "did": "did:example:2" }]
}
```

The corresponding controller code for producing this is:

```ts
import type { XrpcContext } from '@thisismissem/adonisjs-atproto-xrpc'
import { app } from '#lexicons'
import Follower from '#models/follower'
import FollowerTransformer from '#transformers/follower_transformer'

async getFollowers(ctx: XrpcContext<typeof app.bsky.graph.getFollowers>) {
  const followers = await Follower.query()
    .where('subject', ctx.params.actor)
    .orderBy('createdAt', 'desc')
    .limit(ctx.params.limit ?? 50)

  return {
    cursor: followers.at(-1)?.id,
    followers: FollowerTransformer.transform(followers),
  }
}
```

### Why not `BaseTransformer.paginate(...)`?

The `Paginator` contract from `@adonisjs/http-transformers` produces `{ data: [...], metadata: {...} }`, which doesn't match the canonical atproto lexicon output schema and will fail response validation. Two reasons it doesn't fit:

| Mismatch             | Detail                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Structure**        | `BaseSerializer.serialize()` hardcodes `{ [wrap ?? 'data']: items, metadata: ... }` as the Paginator envelope. The subclassing knobs (`wrap`, `definePaginationMetaData`) can rename or retype the parts but can't change the outer shape. |
| **Pagination model** | Adonis paginators are page-number based (`currentPage`, `lastPage`, `total`). XRPC uses opaque cursors — there's no semantic mapping between the two metadata models.                                                                      |

If you reach for `paginate()` out of habit, the serializer doesn't intercept or reshape it — you'll just get a wire-format response that fails atcute's response-schema validation. Use the flat-shape pattern above instead.
