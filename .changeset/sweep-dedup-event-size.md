---
"files-sdk": patch
---

`files-sdk/dedup` no longer strips `size` and `etag` from provider storage events for objects it didn't write. A pointer it writes is always an empty object, so an event that reports a non-empty body is for an ordinary object in a mixed bucket and now keeps its own size and ETag. Events for empty objects, or without a size, still have both cleared, since they may be pointers. `files-sdk/encryption` and `files-sdk/compression` still clear `size` on every event: an event carries no object metadata, so their objects can't be told apart from others.
