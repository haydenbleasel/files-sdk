---
"files-sdk": patch
---

`url()` and `signedUploadUrl()` on `files-sdk/s3`, `files-sdk/s3-fetch`, the S3-compatible adapters, `files-sdk/bun-s3`, and the `files-sdk/r2` binding's hybrid signer now throw `Invalid` for an `expiresIn` or `defaultUrlExpiresIn` that isn't a whole number of seconds of at least 1. A zero, negative, fractional, or `NaN` lifetime used to mint a URL that was dead on arrival; only the seven-day ceiling was checked.
