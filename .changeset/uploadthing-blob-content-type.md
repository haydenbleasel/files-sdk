---
"files-sdk": patch
---

`files-sdk/uploadthing` now uploads a `Blob` or `File` body with its own `type` when no `contentType` is passed. The type was dropped before, so the file was stored with a type guessed from the key's extension, or `application/octet-stream` for a key without one.
