---
'@thisismissem/adonisjs-atproto-xrpc': patch
---

Document the canonical shape for paginated XRPC queries: a flat `{ cursor, <pluralized>: Transformer.transform(...) }` object. Reaching for `BaseTransformer.paginate()` produces a nested `{ data, metadata }` envelope that does not match the XRPC wire format — this note exists to surface that trap before it costs a debugging session.

Also adds `XrpcSerializer` (an internal `BaseSerializer` subclass) that the dispatch layer will use to unpack transformer contracts. Serializer customization via `defineConfig` is planned for a future release.
