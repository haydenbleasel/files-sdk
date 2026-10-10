---
"files-sdk": patch
---

`files-sdk/azure` `copy()` now copies blobs larger than 256 MiB. It used Copy Blob From URL only, which refuses bigger sources with a 409 that surfaced as a `Conflict` error. Now, when that cap is the cause, it falls back to the asynchronous Copy Blob and resolves once the copy finishes. A failed or aborted copy rejects with a `Provider` error carrying Azure's reason.
