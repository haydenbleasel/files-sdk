---
"files-sdk": patch
---

The memory adapter no longer hands out its own stored bytes on read. `download()`, `head()`, and ranged downloads passed the store's `Uint8Array` (or a view over it) straight into the returned file, and `stream()` enqueues that exact array, so a reader mutating a chunk silently corrupted the stored object without changing its etag. Read paths now copy the bytes out, matching the value semantics uploads already had.
