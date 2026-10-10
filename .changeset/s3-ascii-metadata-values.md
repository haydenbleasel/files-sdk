---
"files-sdk": patch
---

`files-sdk/s3`, `files-sdk/s3-fetch`, and every S3-compatible adapter now refuse user `metadata` values that aren't printable ASCII, including Latin-1 text such as `café`, with an `Invalid` error before any request. Such a value used to go out and fail as `SignatureDoesNotMatch`, reported as `Unauthorized`, because the HTTP client sends a Latin-1 character as one byte while SigV4 signs it as two. Encode the value first, for example with `encodeURIComponent`. The R2 binding stores metadata without HTTP headers, so it still accepts any text.
