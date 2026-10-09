---
"files-sdk": major
---

`signedUploadUrl({ minSize })` without `maxSize` now throws `Unsupported` on `files-sdk/s3`, `files-sdk/s3-fetch`, `files-sdk/r2`, `files-sdk/bun-s3`, and the adapters built on them, instead of returning a presigned PUT that silently accepts empty uploads. On `s3()`, pass `maxSize` too to get a POST policy that enforces both. `minSize: 0` still returns a PUT.
