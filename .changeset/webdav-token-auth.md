---
"files-sdk": patch
---

`files-sdk/webdav` now uses token auth when a `token` is passed without `authType`, as documented. The `webdav` client inferred no auth in that case, so requests went out without an `Authorization` header.
