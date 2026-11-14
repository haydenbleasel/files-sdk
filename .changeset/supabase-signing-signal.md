---
"files-sdk": patch
---

`files-sdk/supabase` now forwards the abort `signal` passed to `url()` and `signedUploadUrl()` to the signing request, so an aborted or timed-out call cancels it instead of leaving it running.
