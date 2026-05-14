---
"files-sdk": minor
---

Add `files.file(key)` to return a `FileHandle` bound to a single key. The handle exposes `upload`, `download`, `head`, `exists`, `delete`, `url`, `signedUploadUrl`, `copyTo`, and `copyFrom` without re-passing the key each time. It's a thin wrapper over the same `Files` methods, so adapters do not need to implement anything extra.
