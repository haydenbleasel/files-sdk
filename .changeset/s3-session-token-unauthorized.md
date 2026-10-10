---
"files-sdk": patch
---

An expired or malformed session token (`ExpiredToken`, `InvalidToken`, which S3 returns as HTTP 400) is now `Unauthorized` on `files-sdk/s3`, `files-sdk/s3-fetch`, and the S3-compatible adapters, instead of a `Provider` error that `retries` reissued.
