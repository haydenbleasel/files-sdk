---
"files-sdk": patch
---

`files-sdk/webdav` now cancels the response when a server ignores the `Range` header on a streamed download, instead of throwing and leaving the full-object response (and its connection) open behind the error.
