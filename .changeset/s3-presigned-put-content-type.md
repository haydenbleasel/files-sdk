---
"files-sdk": patch
---

Bind `contentType` into presigned PUT URLs from the S3 adapter (`files-sdk/s3`). `signedUploadUrl(key, { contentType })` without `maxSize` returned a URL signed over the `host` header only, because the AWS presigner leaves `Content-Type` out of the signature by default. The `Content-Type` header it handed back was advisory, and a client could upload any type, despite `contentType` being documented as bound into the signature. The URL now signs `content-type` too, so an upload with a different Content-Type is rejected with a 403. This covers every S3-compatible adapter built on `s3()` (Spaces, Wasabi, Backblaze B2, Tigris, Hetzner, and the rest) and R2, MinIO, and RustFS on `client: "aws-sdk"`; the `fetch` engine already signed it. Send the returned `headers` unchanged with the upload.
