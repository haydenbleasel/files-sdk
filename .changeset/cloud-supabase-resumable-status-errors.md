---
"files-sdk": patch
---

`files-sdk/supabase` resumable (`control`) uploads now classify TUS failures by HTTP status: 401/403 are `Unauthorized`, an expired or terminated upload (404/410) is `NotFound`, and an offset mismatch (409) is `Conflict`, none of which are retried. Previously every failure was a retryable `Provider` error, so a rejected key or an expired session was re-sent chunk by chunk before failing with the wrong code.
