---
"files-sdk": patch
---

`files-sdk/cloudinary`'s `signedUploadUrl()` now fails closed on constraints it cannot enforce: a positive `minSize` throws (like `maxSize` already did), and `contentType` throws instead of being signed as a `content_type` field that Cloudinary ignores. Omit `contentType`, or restrict formats with an upload preset's `allowed_formats`.
