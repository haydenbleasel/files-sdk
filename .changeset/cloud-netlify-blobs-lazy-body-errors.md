---
"files-sdk": patch
---

`files-sdk/netlify-blobs` now maps failures when reading the body of a `head()` or `list()` result. A store error, such as a rejected token, now fails `text()`, `arrayBuffer()`, and `stream()` with a `FilesError` instead of the raw `BlobsInternalError`.
