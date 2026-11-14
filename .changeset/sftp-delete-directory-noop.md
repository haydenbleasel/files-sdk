---
"files-sdk": patch
---

`files-sdk/sftp` `delete()` on a key that resolves to a directory is now a no-op, like a missing key and like the other filesystem-style adapters, instead of failing with a retryable `Provider` (or `Unauthorized`) error from the refused `unlink`.
