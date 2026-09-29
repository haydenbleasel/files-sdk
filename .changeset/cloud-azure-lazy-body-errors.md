---
"files-sdk": patch
---

`files-sdk/azure` now maps failures when reading the body of a `head()` or `list()` result. For a blob deleted in between, `text()`, `arrayBuffer()`, and `stream()` now fail with a `FilesError` (`NotFound`) instead of the raw Azure `RestError`.
