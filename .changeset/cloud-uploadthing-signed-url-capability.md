---
"files-sdk": patch
---

`files-sdk/uploadthing` with `acl: "private"` now reports the 7-day `capabilities.signedUrl.maxExpiresIn` cap that `generateSignedURL` enforces, so the `files-sdk/api` gateway clamps a longer requested expiry instead of failing the call.
