---
"files-sdk": patch
---

`files-sdk/appwrite` resumable uploads now classify a failed chunk by its HTTP status (`409` as `Conflict`, `401`/`403` as `Unauthorized`, `404` as `NotFound`). Previously every chunk failure was a generic `Provider` error, so a chunked upload onto an existing file ID was retried with backoff instead of failing with `Conflict`.
