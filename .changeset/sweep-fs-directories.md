---
"files-sdk": patch
---

The filesystem adapter (`files-sdk/fs`) no longer treats a directory as an object. `head()`, `exists()`, `download()`, `copy()`, and `move()` on a key that is a directory now report `NotFound`, the same as a cloud store does for a prefix with no object. Before, `head()` described the folder, `exists()` returned `true`, `download()` failed with a retryable `Provider` error, and `move()` renamed the whole directory tree. `delete()` of a directory key is now a no-op, the same as deleting a missing key. Writing a file where a directory already exists (an `upload`, `copy`, or `move` onto a folder key) now fails with `Conflict` instead of a retryable `Provider` error. `delete()` also now fails with `Invalid` when the configured `root` is a plain file. The `root` option docs now say that keys escaping the root throw `Invalid`, which is what the adapter has thrown since v3.
