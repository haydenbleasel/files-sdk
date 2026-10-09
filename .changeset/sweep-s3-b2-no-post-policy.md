---
"files-sdk": patch
---

Reject `maxSize` up front on the Backblaze B2 adapter (`files-sdk/backblaze-b2`). B2's S3-compatible API doesn't support browser-based uploads with presigned POST, but the adapter inherited the S3 engine's `capabilities.signedUpload.maxSize: true`, so `signedUploadUrl(key, { maxSize })` returned a presigned POST form that B2 refuses at upload time. The adapter now declares `maxSize: false`, and `signedUploadUrl()` throws `Unsupported` for `maxSize` (and for a positive `minSize`, which needs the same POST policy) before signing, the way R2 does. Presigned PUT uploads, including a signed `contentType`, are unchanged.
