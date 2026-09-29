---
"files-sdk": patch
---

`files-sdk/appwrite` resumable uploads no longer delete an existing file when the upload is aborted before any of its chunks landed. Previously `control.abort()` always deleted the file at the key, so aborting after Appwrite refused a chunked upload onto an existing file ID (or before the first chunk finished) deleted that existing file.
