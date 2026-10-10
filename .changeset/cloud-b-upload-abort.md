---
"files-sdk": patch
---

`files-sdk/gcs`, `files-sdk/firebase-storage`, and `files-sdk/bunny-storage` now honor `signal` (and `timeout`) on uploads. Previously an aborted or timed-out upload kept running in the background and could land later, over a newer write. Now aborting cancels the in-flight request: GCS and Firebase destroy the upload stream, and Bunny Storage, whose SDK takes no signal, errors the request body instead. Bunny Storage's `download()` and `copy()` honor the signal the same way.
