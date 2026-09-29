---
"files-sdk": patch
---

Buffered ranged downloads from `files-sdk/azure` now clamp a range `end` past the end of the blob to the blob's size, as streamed downloads and other adapters already do, instead of failing.
