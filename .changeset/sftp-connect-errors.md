---
"files-sdk": patch
---

`files-sdk/sftp` now maps connect failures like every other error, so a rejected login is `Unauthorized` instead of a retryable `Provider` error that the client kept retrying.
