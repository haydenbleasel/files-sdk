---
"files-sdk": patch
---

A failed public-blob read in the Vercel Blob adapter's `download()` (`files-sdk/vercel-blob`) now maps its HTTP status to the standard error codes (401/403 → `Unauthorized`, 409/412 → `Conflict`, 404/410 → `NotFound`). Before, every status except 404 was treated as a retryable `Provider` error.
