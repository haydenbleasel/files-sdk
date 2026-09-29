---
"files-sdk": patch
---

`files-sdk/onedrive` and `files-sdk/sharepoint` now report rejected credentials as `Unauthorized`. The Graph client strips an auth failure down to its error name, so a revoked `oauth` refresh token or a bad `clientCredentials` secret surfaced as a retryable `Provider` error. A throttled (429) or failing (5xx) token endpoint during an `oauth` refresh now stays a retryable `Provider` error instead of `Unauthorized`.
