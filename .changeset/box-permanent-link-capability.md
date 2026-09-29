---
"files-sdk": patch
---

`files-sdk/box` now reports `capabilities.signedUrl.supported: false` when built with `publicByDefault` or `publicBaseUrl`, since `url()` returns a permanent public link in those modes rather than a signed one. The `defaultUrlExpiresIn` docs now say it is accepted for API symmetry but not honoured, because Box controls the download URL's lifetime.
