---
"files-sdk": patch
---

`list()` items under `files-sdk/compression` now return the original bytes from their body accessors on adapters whose listing carries no object metadata, such as S3 and the S3-compatible adapters. Without the algorithm marker in the listing the plugin passed those items through untouched, so `text()`, `arrayBuffer()`, `blob()` and `stream()` returned the stored compressed bytes; they now download the object back through the plugin and decompress it. Such items still report the stored size, since the original size lives in metadata the listing doesn't include.
