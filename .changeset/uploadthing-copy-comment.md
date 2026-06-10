---
"files-sdk": patch
---

Correct the UploadThing adapter's `copy()` documentation: it claimed the re-upload streams without buffering, but `uploadFiles` requires a Blob, so the body is fully buffered in memory — exactly the multi-GB scenario the comment claimed to protect against. The comment now states the real behavior and its memory implications. No behavior change.
