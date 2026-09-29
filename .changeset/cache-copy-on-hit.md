---
"files-sdk": patch
---

`cache()` (`files-sdk/cache`) now hands out copies of cached download bytes and metadata. Previously a cache hit returned the cached buffer and `metadata` object by reference, and `stream()` enqueued the cached buffer itself, so a caller mutating a chunk or a `metadata` field changed what every later hit returned.
