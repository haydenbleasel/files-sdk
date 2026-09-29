---
"files-sdk": patch
---

`files-sdk/google-drive` now maps a rejected OAuth grant (a revoked refresh token, a bad or deleted service-account key, reported as `invalid_grant` / `invalid_client`) to `Unauthorized` instead of a retryable `Provider` error. A failed resumable-session initiation, for `signedUploadUrl()` or a resumable `upload()`, is now classified like any other Drive error. A 401 maps to `Unauthorized`, a missing file to `NotFound`, and a rate-limited 403 stays a retryable `Provider` error. Resumable uploads used to report every initiation failure as `Provider`, and `signedUploadUrl()` treated a rate-limited 403 as `Unauthorized`.
