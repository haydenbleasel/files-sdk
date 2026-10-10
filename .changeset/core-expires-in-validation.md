---
"files-sdk": patch
---

`url()` and `signedUploadUrl()` in `files-sdk` now reject an `expiresIn` that isn't a positive whole number of seconds with an `Invalid` error before anything is signed. Before, values like `-60`, `0`, `NaN`, or `0.5` were passed to the signer and came back as URLs that never worked.
