---
"files-sdk": patch
---

`files-sdk/ftp` `list()` no longer comes back empty when a subdirectory disappears (or answers "not found") partway through the recursive walk: that directory is skipped and the rest is listed, while a missing root still lists as empty. A 450 reply ("file busy") is now a retryable `Provider` error rather than `NotFound`.
