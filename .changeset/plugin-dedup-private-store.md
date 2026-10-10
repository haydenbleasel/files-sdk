---
"files-sdk": patch
---

`files-sdk/dedup` now reserves its blob store (`.dedup` by default) for the instance, the way `versioning()` and `softDelete()` reserve theirs. Previously a `files-sdk/api` gateway client could list `.dedup/`, download another user's content by its hash, or delete or move a blob and break every pointer to it; those requests now get a `403`. A `move` out of the store through the instance is also refused (it would remove the blob), and a backslash spelling such as `.dedup\x` is recognized as a store key.
