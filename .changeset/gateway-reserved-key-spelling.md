---
"files-sdk": patch
---

The `files-sdk/api` gateway now refuses keys inside a plugin's reserved storage however they're spelled. On a case-insensitive store or a Windows filesystem, `.TRASH/notes.txt` or `.trash\notes.txt` reached the `softDelete()` trash (and `.VERSIONS/…` the version store), so a client allowed to `delete` but not `purge` could hard-delete a trashed file; those now get `403` like `.trash/notes.txt`. A `restoreVersion` `versionId` containing a backslash, `..`, or a NUL byte is now refused with `422`, like one containing a slash.
