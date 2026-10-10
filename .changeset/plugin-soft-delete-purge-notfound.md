---
"files-sdk": patch
---

`files-sdk/soft-delete`'s `purge()` is now idempotent on adapters whose `delete` throws `NotFound` for a missing key, such as GCS and Firebase. `purge(key)` with nothing trashed used to reject with `NotFound` there, and a whole-trash `purge()` failed when an object was purged concurrently; both now resolve.
