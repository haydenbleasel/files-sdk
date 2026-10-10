---
"files-sdk": patch
---

`copy()` and `move()` on `files-sdk/s3`, `files-sdk/s3-fetch`, and the S3-compatible adapters now handle sources over 5 GiB. S3's single `CopyObject` request refuses them, which used to surface as a retried `Provider` error; the adapter now confirms the size with a HEAD and copies the object server-side with a multipart copy (`UploadPartCopy`), carrying its content type, cache and disposition headers, and user metadata. On AWS every part is pinned to the source's ETag, so a source overwritten mid-copy fails with `Conflict`. A conditional copy of such a source throws `Unsupported`, since it can't stay one atomic request.
