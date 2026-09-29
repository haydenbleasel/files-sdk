---
"files-sdk": patch
---

Corrected several `files-sdk` type-definition docs: `timeout` applies per attempt, bulk uploads never retry (but plugin re-routed sub-operations do and fire `onRetry`), the per-adapter support lists for `range`, `delimiter`, `metadata`, `cacheControl`, and `control`, the `SignedUrlCapability` and `SignUploadOptions.maxSize` examples, the `url()` note on key encoding (public URLs percent-encode each key segment), and the `sync()` progress ordering.
