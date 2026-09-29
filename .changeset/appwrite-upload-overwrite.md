---
"files-sdk": patch
---

`files-sdk/appwrite` `upload()` and `copy()` now overwrite an existing key instead of failing with `Conflict`. Appwrite can't update a file's content, so the existing file is deleted and created again; this isn't atomic, and file-level permissions on the old file aren't carried over.
