---
"files-sdk": patch
---

`files-sdk/dropbox`'s `url()` now applies the 4-hour `expiresIn` cap only to temporary links. With `publicByDefault` or `publicBaseUrl`, a longer `expiresIn` used to throw with advice to set `publicByDefault` even when it was set. In those permanent-link modes `capabilities.signedUrl` now reports `supported: false` with no `maxExpiresIn`.
