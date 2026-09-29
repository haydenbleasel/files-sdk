---
"files-sdk": patch
---

`files-sdk/s3` (and the S3-compatible adapters built on it) now reports a failed body read on a `head()` result or a `list()` item as a `FilesError`. Previously the lazy `GetObject` behind `text()`, `arrayBuffer()`, `blob()`, and `stream()` let the raw AWS SDK exception escape, so an object deleted after it was listed surfaced as an `S3ServiceException` instead of a `NotFound` error. The `fetch` engine (`files-sdk/s3-fetch`, `client: "fetch"`) already behaved this way.
