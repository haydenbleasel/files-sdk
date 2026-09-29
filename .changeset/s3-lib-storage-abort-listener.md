---
"files-sdk": patch
---

`files-sdk/s3` (and every adapter built on it: r2, minio, rustfs, wasabi, and the other S3-compatible wrappers) now detaches its abort listener once a multipart, progress, or unknown-length stream upload finishes. Previously the listener stayed on the caller's `signal` until that signal aborted, so a long-lived signal such as a `Files`-level default kept every finished upload, and the body it held, in memory.
