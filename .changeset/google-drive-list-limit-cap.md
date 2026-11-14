---
"files-sdk": patch
---

`files-sdk/google-drive` `list()` now caps `limit` at 1000, the largest `pageSize` Drive accepts. A larger `limit` was sent as-is and failed the whole listing with a `400` from Drive.
