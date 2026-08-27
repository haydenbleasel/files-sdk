---
"files-sdk": patch
---

The `zip()` plugin now requests each entry's body as a stream when building an archive, so large files are no longer fully buffered in memory before being written. Archive contents are unchanged.
