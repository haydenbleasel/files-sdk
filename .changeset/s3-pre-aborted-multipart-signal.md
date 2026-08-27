---
"files-sdk": patch
---

S3 multipart, progress-reporting, and unsized-stream uploads now honor a signal that was already aborted by the time the upload started. The lib-storage path attached only an `"abort"` listener, which never fires for a signal that flipped during the body normalization and lazy import that run first, so the upload proceeded and the object landed after the caller had been told it was aborted. The upload now aborts immediately and rejects with the usual `aborted` error.
