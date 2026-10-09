---
"files-sdk": patch
---

`copy()` and `move()` on the Dropbox adapter (`files-sdk/dropbox`) now overwrite an existing file at the destination, as they do on S3 and the other adapters. Dropbox's `files/copy_v2` has no overwrite mode, so these calls used to fail with `Conflict`. On a `to/conflict/file` error, the adapter now deletes the destination file (Dropbox keeps it in version history) and copies again. A folder at the destination, or the same file under a different casing, still fails with `Conflict`. Calling the resumable-upload driver out of order (`upload session not started`, or `complete()` before the last chunk) now throws `Invalid` instead of a retryable `Provider` error.
