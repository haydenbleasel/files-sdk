---
"files-sdk": patch
---

`files-sdk/uploadthing`'s `signedUploadUrl()` now throws on a positive `minSize` instead of silently ignoring it, because UploadThing's ingest URLs have no minimum-size constraint. `minSize: 0` is still accepted.
