---
"files-sdk": patch
---

`files-sdk/google-drive` now rejects keys, metadata entries, content types, and `cacheControl` values that overflow Drive's 124-byte limit per `appProperties` entry (key and value, UTF-8) with a non-retryable error before any Drive call. Keys can be at most 117 bytes. These writes used to fail with a 400 that was retried as a transient `Provider` error.
