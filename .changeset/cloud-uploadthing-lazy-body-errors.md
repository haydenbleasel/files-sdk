---
"files-sdk": patch
---

`files-sdk/uploadthing` now maps failures when reading the body of a `head()` or `list()` result. A transport error, or a signing error for a private file, now fails `text()`, `arrayBuffer()`, and `stream()` with a `FilesError` instead of escaping raw.
