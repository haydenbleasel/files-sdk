---
"files-sdk": patch
---

A zero-byte upload through the `files-sdk/api` gateway no longer fails with `422 missing request body` on Bun, Deno, or Cloudflare Workers. Those runtimes give a `PUT` with `Content-Length: 0` a `null` body, which the keyed upload and the proxy upload now treat as an empty body.
