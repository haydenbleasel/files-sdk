---
"files-sdk": patch
---

`files-sdk/memory` ETags no longer collide for different bodies (#177). The adapter hashed bytes with a 31-bit polynomial hash, so trivially related bodies shared an ETag: `"Aa"` and `"BB"` both came out as `"00000840"`, and leading zero bytes didn't change the hash at all. Because `sync()` treats a matching size and ETag as unchanged, it silently skipped a file whose bytes had changed, and the gateway's `If-Range` check could accept a stale validator. The ETag is now the quoted MD5 of the bytes (computed in pure JS, so the adapter still runs in browsers and edge runtimes), the same value S3 returns for a single-part upload. Identical content still keeps the same ETag across re-uploads and copies.
