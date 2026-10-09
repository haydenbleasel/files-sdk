---
"files-sdk": patch
---

`presign` on the `files-sdk/api` gateway now signs upload targets at most `maxConcurrency` at a time (default 16), like the bulk operations, instead of firing one signing call per file all at once for a batch of up to `maxBatchSize` files.
