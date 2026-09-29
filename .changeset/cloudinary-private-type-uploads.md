---
"files-sdk": patch
---

`files-sdk/cloudinary` now signs and sends the adapter's delivery `type` on resumable (`control`) uploads and in `signedUploadUrl()` fields. With `type: "private"` or `"authenticated"`, those uploads previously landed as public `upload` assets that the adapter's own `head()`, `list()`, and `download()` could not find.
