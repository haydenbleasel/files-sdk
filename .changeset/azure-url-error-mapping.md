---
"files-sdk": patch
---

Signing failures in `files-sdk/azure` `url()`, such as a 403 when fetching a user delegation key, are now mapped to a `FilesError` (for example `Unauthorized`) instead of escaping as the raw Azure SDK error.
