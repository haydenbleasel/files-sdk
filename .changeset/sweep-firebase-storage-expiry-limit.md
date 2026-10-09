---
"files-sdk": patch
---

The Firebase Storage adapter (`files-sdk/firebase-storage`) now rejects an expiry over V4 signing's 7-day limit with `Invalid` before signing, matching the S3 adapters. This covers `url()` (including a too-long `defaultUrlExpiresIn`) and both `signedUploadUrl()` shapes. Before, `@google-cloud/storage` threw a plain `Error`, which was mapped to a retryable `Provider` error.
