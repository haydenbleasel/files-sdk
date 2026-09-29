---
"files-sdk": patch
---

`files-sdk/api` now bounds the work a single request can ask for. Bulk `keys[]`, presign `files[]` and `complete` `completions[]` over `maxBatchSize` (default 1000) get `413` with reason `count`. A client-supplied bulk `concurrency` is clamped to `maxConcurrency` (default 16), and a `search` page `limit` to `maxListLimit`. A JSON body over `maxJsonBodySize` (default 1 MiB) gets `413` without being buffered. All three limits are new `createFilesRouter` options.
