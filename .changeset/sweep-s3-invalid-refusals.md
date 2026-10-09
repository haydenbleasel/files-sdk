---
"files-sdk": patch
---

Report local refusals on the S3 engines as `Invalid` instead of a retryable `Provider` error. User metadata that can't travel as an `x-amz-meta-*` header (a value with characters outside Latin-1 or control characters such as CR/LF, or a key that isn't an HTTP token) was rejected by the HTTP client before any request was sent, but surfaced as `Provider`, so `retries` reissued an upload that could never succeed. `files-sdk/s3` (uploads, conditional uploads, and resumable sessions) and `files-sdk/s3-fetch` now check metadata up front and throw `Invalid` with a hint to encode the value (for example with `encodeURIComponent`). This covers every adapter built on either engine, including R2, MinIO, and RustFS. Driving an S3 resumable-upload driver out of order (a part, probe, or complete before `begin()` or `adopt()`) is also `Invalid` now.
