---
"files-sdk": patch
---

`files-sdk/vercel-blob` no longer fails a stream upload when the follow-up `head()` that reads the stored size fails. The blob is already written at that point, so `upload()` now resolves with `size: 0` instead of reporting a stored blob as not uploaded.
