---
"files-sdk": minor
---

Add Bun S3 adapter at `files-sdk/bun-s3`, backed by Bun's native `Bun.S3Client` instead of `@aws-sdk/client-s3`. Use this when you're already on Bun and want to skip the AWS SDK dependency. Implements the full adapter surface (upload, download, head, exists, delete, copy, list, url, signedUploadUrl) with three deliberate limitations vs `files-sdk/s3`: `copy()` is client-side (Bun has no server-side `CopyObject` primitive), and `upload(metadata|cacheControl)` plus `signedUploadUrl(maxSize)` throw because `Bun.S3Client` doesn't expose equivalent options. Pass `client: Bun.s3` to reuse the global singleton, or hand in any custom `Bun.S3Client`-shaped instance.
