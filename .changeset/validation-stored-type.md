---
"files-sdk": patch
---

`validation()` (`files-sdk/validation`) now stores the type it approved. With `allowedTypes` set, the checked type (an explicit `contentType`, else the `Blob`'s type, else the type implied by the key's extension) is forwarded as the upload's `contentType`. Previously an upload approved as `image/png` from its `.png` key was stored as the adapter's default, and with a size rule a string body was forced to `text/plain`.
