---
"files-sdk": patch
---

`files-sdk/validation` and `files-sdk/content-type` now read an empty `contentType` (`""`, which is what `{ contentType: file.type }` passes for a file the browser can't type) as "not declared", the way the core does. Both plugins used to reject the upload with a "malformed content type" error; they now fall back to the `Blob`'s own type, then the key's extension, and check that.
