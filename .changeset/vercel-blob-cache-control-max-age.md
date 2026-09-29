---
"files-sdk": patch
---

`files-sdk/vercel-blob` now throws when `upload({ cacheControl })` has no `max-age` directive (for example `"no-store"`). Vercel Blob only stores a cache max-age, so such values used to be silently dropped; pass a value like `"public, max-age=3600"` instead.
