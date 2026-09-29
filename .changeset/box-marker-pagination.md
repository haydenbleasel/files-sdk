---
"files-sdk": patch
---

`files-sdk/box` now pages folder listings by marker instead of offset, in `list()` and in the key lookups every other method runs. Box rejects an `offset` above 10,000, so folders larger than that could neither be listed past that point nor have their later files found. `list()` cursors are now Box's opaque markers; numeric cursors from earlier versions are no longer accepted.
