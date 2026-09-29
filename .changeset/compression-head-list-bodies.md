---
"files-sdk": patch
---

`head()` and `list()` results under `files-sdk/compression` now return the original bytes from their body accessors. They already reported the uncompressed `size`, but `text()`, `arrayBuffer()`, `blob()` and `stream()` returned the stored compressed bytes; they now lazily download the object back through the plugin and decompress it.
