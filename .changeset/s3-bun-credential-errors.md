---
"files-sdk": patch
---

`files-sdk/bun-s3` now reports bad credentials on `list()`, `upload()`, `delete()`, and `copy()` as `Unauthorized`. Bun's S3 errors carry no HTTP status, and `SignatureDoesNotMatch`, `InvalidAccessKeyId`, `ExpiredToken`, and `InvalidToken` weren't recognized, so a wrong key or secret was a `Provider` error that `retries` reissued.
