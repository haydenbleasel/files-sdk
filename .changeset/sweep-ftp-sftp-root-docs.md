---
"files-sdk": patch
---

The `root` option docs for `files-sdk/ftp` and `files-sdk/sftp` now say that keys escaping the root throw `Invalid`. The adapters have thrown `Invalid` since v3, but the docs still said `Provider`.
