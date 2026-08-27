---
"files-sdk": patch
---

`UploadControl.abort()` is now honored when it lands while a resumable upload is finalizing. Previously an abort that arrived after the last chunk but during the provider's `complete()` call was overwritten: the control flipped from "aborted" to "completed" and `upload()` resolved. The orchestrator now checks for an abort before finalizing and again after, so `upload()` rejects with the aborted `FilesError` and the control stays aborted.
