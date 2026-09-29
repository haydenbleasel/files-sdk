---
"files-sdk": patch
---

`files-sdk/api` no longer applies the cross-origin (CSRF) check to the bulk `head` request. Like `head` and `exists`, it is a read, and the `Origin` check is only for requests that change storage.
