---
"files-sdk": patch
---

`files-sdk/netlify-blobs` now infers the content type on upload the same way the other adapters do: a `Blob` or `File` keeps its own `type` and a string body is stored as `text/plain; charset=utf-8`. Previously every upload without an explicit `contentType` was recorded as `application/octet-stream`, so `head()` and `download()` reported the wrong type.
