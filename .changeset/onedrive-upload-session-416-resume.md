---
"files-sdk": patch
---

`files-sdk/onedrive` and `files-sdk/sharepoint` resumable uploads now recover when Graph answers a retried chunk with `416` because it already holds those bytes: the driver reads the session's `nextExpectedRanges` and continues from there instead of failing the upload.
