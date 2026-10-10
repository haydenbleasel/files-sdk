---
"files-sdk": patch
---

A `download()` whose `range` starts past the end of the object (`416 InvalidRange`) is no longer retried on `files-sdk/s3`, `files-sdk/s3-fetch`, the S3-compatible adapters, `files-sdk/bun-s3`, or the `files-sdk/r2` binding (error code 10039). It stays a `Provider` error, since it's the provider's answer, but is now marked `permanent`, so `retries` doesn't reissue a request that can only fail the same way.
