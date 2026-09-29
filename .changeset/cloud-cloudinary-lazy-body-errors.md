---
"files-sdk": patch
---

`files-sdk/cloudinary` now maps failures when reading the body of a `head()` or `list()` result. A transport error now fails `text()`, `arrayBuffer()`, and `stream()` with a `FilesError` instead of escaping raw.
