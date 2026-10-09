---
"files-sdk": patch
---

The Netlify Blobs adapter (`files-sdk/netlify-blobs`) now reports a missing site ID or token (`MissingBlobsEnvironmentError`) and an unknown region (`InvalidBlobsRegionError`) as `Invalid` instead of a retryable `Provider` error. Both are configuration problems, thrown when `netlifyBlobs()` builds the store, so retrying could never fix them.
