---
"files-sdk": patch
---

`files.abortUpload()` on the Supabase adapter (`files-sdk/supabase`) now checks the status of the TUS session `DELETE` instead of ignoring it. A refused or failed cancel, which leaves the upload session live, now rejects: a 401/403 is `Unauthorized`, and a 5xx is a retryable `Provider` error. A 404 or 410 means the session already completed or expired, so it still resolves. A network failure during the cancel is mapped to `Provider` instead of surfacing as a raw error.
