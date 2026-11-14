---
"files-sdk": patch
---

`files-sdk/sftp` `download()` and `copy()` now throw `NotFound` for a key that resolves to a directory, as `head()` and `exists()` already report it. Reading one used to fail with a retryable `Provider` error, and a streamed download returned a file that errored mid-read.
