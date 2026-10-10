---
"files-sdk": patch
---

A resumable (`control`) upload on `files-sdk/s3` and the S3-compatible adapters no longer fails after the object has committed when the follow-up `HeadObject` is denied or fails (for example, a principal allowed `PutObject` but not `GetObject`). The upload now resolves with the summed part sizes and the upload's content type, where it used to reject with `Unauthorized` and leave a resume that could only hit `NoSuchUpload`.
