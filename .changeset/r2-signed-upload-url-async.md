---
"files-sdk": patch
---

In HTTP mode, `files-sdk/r2`'s `signedUploadUrl({ maxSize })` now returns a rejected promise instead of throwing synchronously, matching binding mode and every other adapter method. This only changes direct adapter calls; `files.signedUploadUrl()` already rejected.
