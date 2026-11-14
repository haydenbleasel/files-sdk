---
"files-sdk": patch
---

`files-sdk/box` resumable uploads now keep the buffered body until the final upload succeeds. A transient failure on that upload used to drop it, so the automatic retry failed with a misleading `Invalid` "resumable session not found" error and the upload could not be finished.
