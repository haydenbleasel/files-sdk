---
"files-sdk": patch
---

`files-sdk/validation` now stops reading a streamed upload as soon as it passes `maxSize`, cancelling the source and rejecting with the size error. It used to buffer the entire stream before measuring it, so an oversized or never-ending body was held in memory in full (or forever) before the limit applied.
