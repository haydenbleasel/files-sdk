---
"files-sdk": patch
---

`list()` items under `files-sdk/dedup` now return the content from their body accessors on adapters whose listing carries no object metadata, such as S3 and the S3-compatible adapters. Without the pointer marker in the listing the plugin passed those items through untouched, so `text()`, `arrayBuffer()`, `blob()` and `stream()` returned the empty pointer; they now follow the pointer to the stored content. Such items still report the pointer's own size and ETag, since the content size and hash live in metadata the listing doesn't include.
