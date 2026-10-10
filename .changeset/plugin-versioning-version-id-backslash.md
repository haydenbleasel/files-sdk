---
"files-sdk": patch
---

`files-sdk/versioning`'s `restoreVersion()` now refuses a `versionId` that is empty or `.`, or that contains a backslash, `..`, or a NUL byte, as it already refused one containing `/` (the `files-sdk/api` gateway refuses the same ids). On a Windows filesystem a `versionId` such as `..\..\users\2\secret\<id>` restored another key's version (possibly another tenant's) into the caller's key. A write to a key such as `.versions/../notes.txt`, which a filesystem resolves to `notes.txt`, is also no longer mistaken for a write inside the version store, so it's snapshotted like the live key it is.
