---
"files-sdk": patch
---

`files-sdk/onedrive` and `files-sdk/sharepoint` now reject `signedUploadUrl({ contentType })` before creating an upload session. A Graph upload session doesn't bind a Content-Type, so the `Content-Type` header the adapter used to return was only advisory, which the `signedUploadUrl` contract rules out. Omit `contentType`, or validate it at your gateway before issuing the URL.
