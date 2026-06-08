---
'@thisismissem/adonisjs-atproto-xrpc': patch
---

**Structured 404 response for unregistered NSIDs** — requests to `/xrpc/<nsid>` for methods not registered on the server now return a spec-aligned JSON error body instead of leaking atcute's default plain-text response.

Previously:

```
HTTP/1.1 404 Not Found
Content-Type: text/plain

Not Found
```

Now:

```
HTTP/1.1 404 Not Found
Content-Type: application/json

{ "error": "NotFound", "message": "Method 'com.example.foo' not found on this server" }
```

The response shape matches the XRPC wire-format convention every other error path on this server produces. Per the atproto XRPC spec, both 404 and 501 are valid for unregistered methods; this package returns 404 (the consumer genuinely hasn't registered the NSID, vs. 501's "known but unimplemented" semantic).

Implemented via atcute's `handleNotFound` hook — wired at provider construction time, no consumer setup required.
