---
"files-sdk": patch
---

Fix `azure()` resumable uploads throwing `NotFound` when resuming a session that was paused or persisted before its first block landed. Azure answers `GetBlockList` with a 404 when the blob has no committed or uncommitted blocks yet; the adapter now treats that as an empty session and uploads from the start.
