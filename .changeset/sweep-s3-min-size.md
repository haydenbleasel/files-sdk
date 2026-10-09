---
"files-sdk": major
---

Fail closed on `signedUploadUrl({ minSize })` without `maxSize` across the S3 family. A size floor is only enforceable through a presigned POST policy's `content-length-range`, which `maxSize` selects, so a positive `minSize` on its own was silently dropped and the returned presigned PUT accepted 0-byte uploads. It now throws `Unsupported` before signing on `files-sdk/s3` (and every adapter built on it, plus MinIO and RustFS on `client: "aws-sdk"`; pass `maxSize` too to get the POST policy that enforces both), `files-sdk/s3-fetch` (and R2, MinIO, and RustFS on `client: "fetch"`), `files-sdk/r2` in every mode, and `files-sdk/bun-s3`. `minSize: 0` asks for nothing and still returns a presigned PUT, matching Azure, Supabase, and Vercel Blob.
