---
"files-sdk": patch
---

`authorize`'s `filterKeys` now applies to every `files-sdk/api` operation that names a key on a plugin or upload path, not only `trashed` and `purge`. `versions`, `restore-version`, and `restore-trashed` refuse a key it hides with a 403 (`Forbidden`), and `complete` reports such an upload as a `Forbidden` error entry.
