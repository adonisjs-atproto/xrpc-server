---
'@thisismissem/adonisjs-atproto-xrpc': patch
---

**Pagination shape for XRPC queries:** return a flat object from paginated handlers, not `BaseTransformer.paginate()`.

```ts
// Correct — matches the XRPC wire format
return {
  cursor: nextCursor,
  records: RecordTransformer.transform(rows),
}

// Wrong — BaseTransformer.paginate() produces { data, metadata } which is not valid XRPC
return RecordTransformer.paginate(rows, meta)
```
