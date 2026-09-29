---
"files-sdk": patch
---

`files-sdk/azure`'s `signedUploadUrl()` now throws on a positive `minSize` instead of silently ignoring it, because a SAS has no minimum-size constraint. `minSize: 0` is still accepted.
