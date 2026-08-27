---
"files-sdk": patch
---

Fix `onedrive()` and `sharepoint()` rejecting every chunk when `multipart.partSize` exceeded Graph's 60 MiB upload-session fragment limit (for example `partSize: 100 MiB`). The requested part size is now clamped to the largest 320 KiB multiple at or below 60 MiB.
