---
"files-sdk": patch
---

`files-sdk/vercel-blob` now maps failures when reading the body of a `head()` or `list()` result. A `blob.get` error in private mode, or a transport error in public mode, now fails `text()`, `arrayBuffer()`, and `stream()` with a `FilesError` instead of escaping raw.
