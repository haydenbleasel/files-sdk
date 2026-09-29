---
"files-sdk": patch
---

`files-sdk/fs`, `files-sdk/appwrite`, and `files-sdk/bunny-storage` now mark their key-validation errors as permanent. These are keys that escape the adapter root or resolve onto it, reserved sidecar names, invalid Appwrite file IDs, and Bunny keys with `.` or `..` segments. Previously these deterministic `Provider` errors counted as retryable, so a call made with `retries` re-sent the same invalid key, with backoff, until the retry budget ran out.
