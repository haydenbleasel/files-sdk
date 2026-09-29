---
"files-sdk": patch
---

`files-sdk/fs` `list()` no longer stops walking when a subdirectory is removed mid-listing. An `ENOENT` from any nested directory ended the whole walk, silently dropping every directory not yet visited; that directory is now skipped, and only a missing root lists as empty.
