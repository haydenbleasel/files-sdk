---
"files-sdk": patch
---

Resumable uploads on `files-sdk/gcs`, `files-sdk/firebase-storage`, and `files-sdk/google-drive` now classify a failed session request by its HTTP status: 404 and 410 (an unknown or expired session) map to `NotFound`, 401/403 to `Unauthorized`, and 409/412 to `Conflict`, all flagged `permanent`. They used to surface as `Provider` errors, so each chunk against a dead session was retried until the retry budget ran out.
