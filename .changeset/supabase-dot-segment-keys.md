---
"files-sdk": patch
---

Reject keys with a `.` or `..` path segment in the Supabase adapter (`files-sdk/supabase`) with an `Invalid` error before any request. The adapter builds its own request URLs for `upload`, `download`, `head`, `exists`, `url`, and `signedUploadUrl`, and a URL resolves those segments, so `a/../b.txt` silently addressed `b.txt`, `../other-bucket/x` reached another bucket, and enough `..` segments left the Storage API altogether, each time with the client's credentials attached. `@supabase/storage-js` 2.119.2 added the same refusal to its own requests; the adapter's requests don't pass through it. If you hand caller-supplied keys to a Supabase-backed `Files` instance, upgrade.
