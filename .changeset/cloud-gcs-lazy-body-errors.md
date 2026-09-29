---
"files-sdk": patch
---

`files-sdk/gcs` now maps failures when reading the body of a `head()` or `list()` result. For an object deleted in between, `text()`, `arrayBuffer()`, and `stream()` now fail with a `FilesError` (`NotFound`) instead of the raw `ApiError`.
