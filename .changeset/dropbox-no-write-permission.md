---
"files-sdk": patch
---

`files-sdk/dropbox` now maps Dropbox's `no_write_permission` error to `Unauthorized` instead of `Conflict`.
