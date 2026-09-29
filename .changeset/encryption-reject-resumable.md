---
"files-sdk": patch
---

`files-sdk/encryption` now refuses resumable uploads: an `upload()` with a `control` throws a permanent `FilesError` before any I/O, and `files.capabilities` reports `multipart: false`. Each upload encrypts under a fresh random data key, so a session resumed in another process spliced parts of two different ciphertexts into an object that could never be decrypted. `multipart: true` without a `control` still works.
