---
"files-sdk": patch
---

`files-sdk/netlify-blobs` now classifies errors by the HTTP status on Netlify's `BlobsInternalError` instead of only parsing it from the message. When Netlify sends an `x-nf-error` header the message no longer contains the status, so 404, 401/403 and 409/412 responses were reported as `Provider` errors rather than `NotFound`, `Unauthorized` and `Conflict`.
