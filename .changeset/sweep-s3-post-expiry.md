---
"files-sdk": patch
---

Apply SigV4's one-week ceiling to presigned POST uploads on the S3 adapter (`files-sdk/s3`). `signedUploadUrl(key, { maxSize, expiresIn })` skipped the `expiresIn` check the presigned PUT path makes, so an `expiresIn` past 604800 seconds produced a POST policy that S3 rejects when it's used. It now throws `Invalid` up front with the same message as the PUT path and `url()`, as `capabilities.signedUpload.maxExpiresIn` already declared. This covers every S3-compatible adapter built on `s3()` and MinIO and RustFS on `client: "aws-sdk"`.
