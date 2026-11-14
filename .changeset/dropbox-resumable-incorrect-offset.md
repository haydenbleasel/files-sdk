---
"files-sdk": patch
---

`files-sdk/dropbox` resumable uploads now continue from the offset Dropbox reports when a chunk is refused with `incorrect_offset` (a chunk that landed but whose reply was lost), and keep the resume token in step. Previously every retry and every later resume re-sent the chunk at the stale offset, so the upload could never finish.
