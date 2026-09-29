---
"files-sdk": patch
---

`files-sdk/pocketbase` `download()` now maps a `401` or `403` from the file endpoint to `Unauthorized`. Previously anything other than a `404` was a `Provider` error, so a refused file token was retried as if it were transient.
