---
"files-sdk": patch
---

Overwriting a key on Google Drive now replaces its metadata instead of merging it with the previous version's. Drive merges `appProperties` on update and only removes a key when it is sent as `null`, so re-uploading with `metadata: { b: "2" }` after `{ a: "1" }` read back as `{ a: "1", b: "2" }` (and a dropped `cacheControl` lingered) while every other adapter yields `{ b: "2" }`. Both buffered and resumable overwrites now clear the stale keys explicitly.
