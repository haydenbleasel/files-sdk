---
"files-sdk": patch
---

`files-sdk/cloudinary` resumable (`control`) uploads now classify a failed chunk by HTTP status, so a rejected signature (401) is an `Unauthorized` error that is not retried. Previously every failed chunk was a retryable `Provider` error.
