---
"files-sdk": patch
---

`files-sdk/fs` resumable uploads now classify filesystem errors from chunk writes like every other method (`ENOENT`/`ENOTDIR` as `NotFound`, `EACCES`/`EPERM` as `Unauthorized`). Previously a failed chunk write surfaced as a generic `Provider` error, so a permission failure was retried as if it were transient.
