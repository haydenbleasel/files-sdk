---
"files-sdk": patch
---

Fix untyped `Blob`/`File` uploads being sent with an empty `Content-Type`. `Blob.type` is `""` (never nullish) when no type was given, so the documented `application/octet-stream` fallback behind a `??` was dead code — the provider received `contentType: ""`. Fixed in the core body normalizer and the same pattern in the box, onedrive, supabase, google-drive, dropbox, r2, uploadthing, and convex adapters.
