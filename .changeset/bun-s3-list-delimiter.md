---
"files-sdk": patch
---

`files-sdk/bun-s3` now supports `list({ delimiter })`. Bun's list forwards the delimiter and returns `commonPrefixes`, which the adapter now surfaces as `prefixes`, and it declares `supportsDelimiter`, so folder listing no longer throws.
