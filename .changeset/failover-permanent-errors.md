---
"files-sdk": patch
---

`files-sdk/failover` no longer fails over on `permanent` errors by default. The core SDK's pre-I/O rejections (an invalid key, or an option the adapter can't honor such as `metadata`, `cacheControl`, `range`, `delimiter`, or `control`) are now `FilesError`s with `permanent: true`, so an upload with metadata to a primary without metadata support throws instead of silently landing on a secondary. The failover docs no longer point to a `replication()` plugin that doesn't exist.
