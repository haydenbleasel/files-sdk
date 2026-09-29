---
"files-sdk": patch
---

User Delegation SAS URLs from `files-sdk/azure` can no longer outlive the delegation key that signs them. With a `credential`, `url()` and `signedUploadUrl()` now throw for an `expiresIn` above 7 days instead of returning a URL that stops working when its key expires, and `files.capabilities.signedUrl.maxExpiresIn` reports the 7-day cap so the gateway clamps to it.
