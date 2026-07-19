---
"files-sdk": patch
---

The `fetch` S3 client now maps post-dispatch failures to `FilesError` like everything else: a download/list/lazy-body read dying mid-stream, and signing errors in `url()` / `signedUploadUrl()` (e.g. an invalid `contentType` header value), previously escaped as raw runtime `TypeError`s when the adapter was used directly.
