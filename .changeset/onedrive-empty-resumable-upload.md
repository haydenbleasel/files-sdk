---
"files-sdk": patch
---

`files-sdk/onedrive` and `files-sdk/sharepoint` now upload an empty body through a resumable (`control`) upload with the simple `PUT /content` and drop the unused upload session. They used to send the invalid chunk header `Content-Range: bytes 0--1/0` to a Graph upload session, which needs at least one byte.
