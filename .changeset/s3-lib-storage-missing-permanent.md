---
"files-sdk": patch
---

`files-sdk/s3` (and the S3-compatible adapters built on it) now marks the error for a missing `@aws-sdk/lib-storage` peer as permanent and keeps the import failure as its `cause`. Previously a `multipart`, `onProgress`, or unknown-length stream upload without the package installed was retried under `retries`, re-issuing an upload that could only fail the same way.
