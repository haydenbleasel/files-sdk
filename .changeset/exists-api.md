---
"files-sdk": minor
---

Add `exists(key)` to the Files API. Returns `true` when the object exists and `false` when the adapter reports a not-found error, without fetching the object body. Implemented across all built-in adapters.
