---
"files-sdk": patch
---

`download()` in `files-sdk/client` now reports the right `size` and `lastModified` more often. On a full proxied download it takes `size` from the gateway's metadata header instead of `Content-Length`, which compression middleware can drop (giving `0`) or rewrite. A download the gateway redirected to storage now falls back to the storage host's `Last-Modified` header for `lastModified`.
