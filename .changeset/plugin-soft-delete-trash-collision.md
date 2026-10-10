---
"files-sdk": patch
---

`files-sdk/soft-delete` now explains a trash collision on hierarchical stores such as `files-sdk/fs` and SFTP. With `a` already in the trash, deleting `a/b` needs a `.trash/a/` folder where the trashed file sits, and used to fail with a bare `EEXIST … mkdir .trash/a` error; it now throws a `Conflict` that names the trashed entry in the way and says to `purge()` (or `restoreTrashed()`) it first. The live object is untouched either way.
