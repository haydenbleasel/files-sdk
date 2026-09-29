---
"files-sdk": patch
---

`files-sdk/webdav`, `files-sdk/ftp`, and `files-sdk/sftp` now reject a key that resolves to the configured root itself (`"/"`, `"."`, `"./"`) before any server call. Previously such a key addressed the root directory: on WebDAV, `files.delete("/")` sent a `DELETE` for the root collection, which removes everything under it. Their key-validation errors (traversal, null bytes, the reserved `.fls-part` suffix) are now also marked permanent, so `retries` no longer re-sends a call that can only fail the same way.
