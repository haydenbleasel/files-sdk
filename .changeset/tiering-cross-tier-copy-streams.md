---
"files-sdk": patch
---

Fix `tiering()` buffering the whole object on a cross-tier `copy` / `move` and on `tier()`. The transfer read the source with a plain `download()`, which buffers the body on most adapters, so a large object was materialized in memory before being re-uploaded — contradicting the plugin's streaming contract. The source is now read with `as: "stream"`, so cross-tier transfers stream end to end.
