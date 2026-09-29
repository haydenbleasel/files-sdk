---
"files-sdk": patch
---

`files-sdk/gcs` and `files-sdk/firebase-storage` now report `capabilities.signedUrl.maxExpiresIn` as 604800 seconds (7 days). `@google-cloud/storage` rejects any V4 signed URL or POST policy that outlives 7 days, but the adapters left the cap unset, so the `files-sdk/api` gateway did not clamp to it and a longer `expiresIn` failed instead.
