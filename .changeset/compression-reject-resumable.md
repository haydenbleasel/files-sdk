---
"files-sdk": patch
---

`files-sdk/compression` now refuses resumable uploads: an `upload()` with a `control` throws a permanent `FilesError` before any I/O, and `files.capabilities` reports `multipart: false`. Compressed output isn't byte-for-byte stable across runtimes or versions (Node and Bun differ for the same input), so a session resumed in another process could splice two different compressed streams into an object that can't be decompressed. `multipart: true` without a `control` still works.
