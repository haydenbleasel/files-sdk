---
"files-sdk": patch
---

`head()` and `list()` results under `files-sdk/dedup` now return the content from their body accessors instead of the empty pointer object. `text()`, `arrayBuffer()`, `blob()` and `stream()` lazily read the content-addressed blob, and `stream()` streams it rather than buffering.
