---
"files-sdk": patch
---

`files.abortUpload()` and `control.abort()` on the OneDrive adapter (`files-sdk/onedrive`) and the SharePoint adapter (`files-sdk/sharepoint`) now check the response to the upload-session `DELETE`. A refused cancel used to resolve as if it had worked, which left the session live. A `401`/`403` now rejects with `Unauthorized`, and a `5xx` rejects with a retryable `Provider` error. A `404` or `410`, meaning the session is already completed, expired, or discarded, still resolves.
