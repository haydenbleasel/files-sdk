---
"files-sdk": patch
---

`files-sdk/s3`, `files-sdk/s3-fetch`, every S3-compatible adapter, and `files-sdk/bun-s3` now refuse a `contentType` or `cacheControl` containing control characters (such as CR/LF) or non-ASCII text with an `Invalid` error before any request, on uploads, resumable uploads, and `signedUploadUrl()`. Such a value used to fail as a retried `Provider` error, or as `Unauthorized` on the aws-sdk client while the fetch client stored it mangled.
