---
"files-sdk": patch
---

`files-sdk/onedrive` and `files-sdk/sharepoint` now classify a failed upload-session request by its status: an expired session (404/410) is `NotFound`, a refusal is `Unauthorized` or `Conflict`, and none of them are retried. They were all thrown as retryable `Provider` errors before.
