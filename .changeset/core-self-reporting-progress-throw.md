---
"files-sdk": patch
---

`files-sdk` now keeps `upload({ onProgress })` fire-and-forget on adapters that report progress themselves (S3 and the S3-compatible adapters, Azure, GCS, Firebase Storage, Vercel Blob, FTP). Previously a throwing `onProgress` on those adapters rejected the upload attempt, and with `retries` set the SDK re-uploaded the whole body on each retry before failing.
