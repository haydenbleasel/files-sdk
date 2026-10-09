---
"files-sdk": patch
---

Give `head()` of a missing key a useful error message on the S3 adapter (`files-sdk/s3`) and every adapter built on it. A HEAD 404 has no body, so the AWS SDK's placeholder message `UnknownError` came through as the `NotFound` error's message. It now reads "The specified key does not exist.", the same text a `download()` of that key gets from S3. The `fetch` engine (`files-sdk/s3-fetch`, and R2, MinIO, and RustFS on `client: "fetch"`) uses the same message instead of the generic "Not found". Other bodyless failures on the AWS SDK path (a HEAD 403 or 500) fall back to the standard `Unauthorized` / provider message instead of `UnknownError`, and `mapS3Error` treats the placeholder as no message.
