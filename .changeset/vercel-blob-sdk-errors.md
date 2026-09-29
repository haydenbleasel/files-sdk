---
"files-sdk": patch
---

`files-sdk/vercel-blob` now classifies `@vercel/blob` errors by their class. The SDK's errors carry no HTTP status and a generic `name`, so every failure used to surface as a `Provider` error: `exists()` on a missing key threw instead of returning `false`, and `head()`/`download()` never reported `NotFound`. Missing blobs now map to `NotFound`, access and token errors to `Unauthorized`, ETag precondition failures and uploads to an existing key under `allowOverwrite: false` to `Conflict`, and deterministic rejections (content type not allowed, file too large, missing store) are flagged `permanent` so `retries` doesn't re-send them.
