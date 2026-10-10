---
"files-sdk": patch
---

A string body uploaded with `files-sdk/client` (or the `useFiles` bindings) and no `contentType` is now stored as `text/plain; charset=utf-8`, as the server SDK stores it. It used to be sent untyped and stored as `application/octet-stream`.
