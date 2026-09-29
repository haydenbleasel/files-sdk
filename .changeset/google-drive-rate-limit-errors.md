---
"files-sdk": patch
---

`files-sdk/google-drive` now maps Drive's `rateLimitExceeded` and `userRateLimitExceeded` 403 responses to a retryable `Provider` error instead of `Unauthorized`, so they are retried with backoff as Google recommends. Other 403s still map to `Unauthorized`.
