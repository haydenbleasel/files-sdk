---
"files-sdk": patch
---

`files.abortUpload()` no longer reports success when the provider refuses to cancel the session. The shared session-URL driver behind GCS (`files-sdk/gcs`), Firebase Storage (`files-sdk/firebase-storage`), and Google Drive (`files-sdk/google-drive`) sent the cancelling `DELETE` and never looked at the response, so a 403 or a 5xx resolved as if the session were gone while it stayed live. The cancel now counts as done only on a 2xx, on 404 or 410 (the session already completed, expired, or was discarded), or on GCS's documented `499` reply to a cancel. Any other status throws: 401 and 403 are `Unauthorized`, and a 5xx is a retryable `Provider` error that `abortUpload()` retries under the instance's `retries` policy. `UploadControl.abort()` mid-upload still treats the cancel as best-effort and doesn't throw.
