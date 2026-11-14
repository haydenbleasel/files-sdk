---
"files-sdk": patch
---

`files-sdk/dropbox` `list()` now caps `limit` at 2000, the largest page Dropbox accepts. A larger `limit` was sent as-is and failed the whole listing with a `400` from Dropbox.
