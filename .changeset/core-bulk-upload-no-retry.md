---
"files-sdk": patch
---

Bulk `upload([...])` no longer silently retries buffered bodies using the client's `retries` setting. It now matches the documented behavior of every other bulk verb: each item is attempted once and a failure lands in `errors`. Single-key `upload()` keeps its retry budget, and `onRetry` still fires only for single-operation calls.
