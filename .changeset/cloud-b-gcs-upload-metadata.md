---
"files-sdk": patch
---

`files-sdk/gcs` and `files-sdk/firebase-storage` `upload()` now take the result's `etag`, `lastModified`, and size from the upload response instead of reading the object back afterwards. A service account that can create objects but not read them (Storage Object Creator) no longer gets an `Unauthorized` error for an upload that landed, and concurrent writers to the same key no longer risk reporting each other's etag. If the response lacks an etag, the follow-up read is best-effort and can't fail the upload.
