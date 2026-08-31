---
"files-sdk": minor
---

r2: default to the fetch client on Cloudflare Workers, and export `s3FetchAdapter` from `files-sdk/r2` for generic S3-compatible endpoints. The `"aws-sdk"` client's XML parsing requires `DOMParser`, which workerd doesn't provide, so it fails at runtime; an explicit `client: "aws-sdk"` still overrides the new default.
