---
"files-sdk": patch
---

`files-sdk/s3` (and the `"aws-sdk"` engine of r2, minio, rustfs, and every S3-compatible wrapper): aborting an upload that goes through `@aws-sdk/lib-storage` (a `ReadableStream` body, `onProgress`, or `multipart`) now cancels the request in flight. The `signal` only stopped new requests from starting, so a single `PutObject` already on the wire still wrote the object after `upload()` had rejected as aborted, and in-flight parts uploaded to the end.
