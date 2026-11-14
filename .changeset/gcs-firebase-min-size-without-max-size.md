---
"files-sdk": patch
---

`files-sdk/gcs` and `files-sdk/firebase-storage` now throw `Unsupported` from `signedUploadUrl()` for a positive `minSize` without `maxSize`, as the S3 adapters do. The size floor is only enforced by the POST policy that `maxSize` selects, so the signed PUT URL returned before accepted uploads below the requested minimum.
