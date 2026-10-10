---
"files-sdk": patch
---

`files-sdk/cloudinary` now invalidates the CDN copy when `copy()` or a resumable (`control`) upload overwrites an existing asset, as a plain `upload()` already did. Without it the CDN kept serving the replaced content until its cache expired.
