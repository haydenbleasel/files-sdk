---
"files-sdk": patch
---

With `fallback: true`, `url()` on `files-sdk/tiering` now checks which tier holds the key and signs against that one. Presigning adapters mint a URL without checking the object exists, so a size-routed object or one moved with `tier()` got a dead link to the other tier. The docs now also describe the merged `list()` as globally key-ordered across pages.
