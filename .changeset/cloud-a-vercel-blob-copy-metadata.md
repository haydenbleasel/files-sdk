---
"files-sdk": patch
---

`files-sdk/vercel-blob` `copy()` now keeps the source's content type and cache max-age. `blob.copy` doesn't carry them over, so every copy, move and versioning snapshot got a content type guessed from the destination's extension and the default one-month cache. The adapter now reads both from the source and passes them to the copy.
