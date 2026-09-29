---
"files-sdk": patch
---

Presigned URLs on the S3 family now reject an `expiresIn` over 604800 seconds (7 days, the SigV4 limit) with a clear `Provider` error on both engines. The fetch engine (`files-sdk/s3-fetch`, and the `client: "fetch"` mode of `files-sdk/r2`, `files-sdk/minio`, and `files-sdk/rustfs`) used to return a URL the server rejected, and the aws-sdk engine threw a bare "S3 error". `files-sdk/s3`, `files-sdk/s3-fetch`, every S3-compatible wrapper, and R2 hybrid signing now declare `capabilities.signedUrl.maxExpiresIn: 604800`, so the `useFiles` gateway clamps expiry to it.
