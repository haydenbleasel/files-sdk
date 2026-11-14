---
"files-sdk": patch
---

The filesystem adapter (`files-sdk/fs`) now treats a key more than one level under an existing file (`a.txt/b/c` when `a.txt` is an object) the way it already treated one directly under it: `delete()` is a no-op instead of throwing `NotFound`, and `upload()`, `copy()`, `move()`, and a resumable upload to such a key reject with `Conflict` instead of a `NotFound` that read as a missing source.
