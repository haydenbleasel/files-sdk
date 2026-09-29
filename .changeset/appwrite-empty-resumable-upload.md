---
"files-sdk": patch
---

`files-sdk/appwrite` now uploads an empty body through a resumable (`control`) upload as a single `createFile` request. It used to send the invalid chunk header `Content-Range: bytes 0--1/0`.
