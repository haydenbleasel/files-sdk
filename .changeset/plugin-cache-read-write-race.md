---
"files-sdk": patch
---

`files-sdk/cache` no longer caches a stale read that overlapped a write. A slow `download()`, `head()`, or `url()` miss that was in flight while an `upload()` (or `delete`, `copy`, `move`) of the same key completed used to store what it had fetched after the write invalidated the key, serving the old value for the full `ttl`; such a read now returns its result without caching it. Writes also drop the key before they run and after any failure, not only after a success or a `Conflict`, since a timed-out write may still have landed.
