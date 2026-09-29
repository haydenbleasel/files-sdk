---
"files-sdk": patch
---

`files-sdk/bun-s3` now rejects a presigned `url()` or `signedUploadUrl()` with an `expiresIn` over 604800 seconds (7 days, the SigV4 limit), with the same permanent `Provider` error as the rest of the S3 family. Bun signed longer lifetimes without complaint, but the server rejected the URL when it was used. The adapter also declares `capabilities.signedUrl.maxExpiresIn: 604800`, so the `useFiles` gateway clamps expiry to it.
