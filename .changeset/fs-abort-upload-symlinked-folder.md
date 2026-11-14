---
"files-sdk": patch
---

`files.abortUpload()` and `control.abort()` on the filesystem adapter (`files-sdk/fs`) no longer remove a resumable upload's partial through a folder that is symlinked outside the adapter root. A key resolving through such a link was already refused by every write, but discarding its session deleted the matching `.fls-part` file outside the root; `abortUpload()` now rejects with `Invalid` and removes nothing.
