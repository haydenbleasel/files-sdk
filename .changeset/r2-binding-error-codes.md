---
"files-sdk": patch
---

`files-sdk/r2` now maps Workers binding error codes to the right `FilesError` codes, following Cloudflare's published table. Bad credentials (10002) and other auth failures (10003, 10018, 10035) are `Unauthorized`, a missing key, bucket, or upload (10007, 10006, 10024) is `NotFound`, and a failed precondition or non-empty bucket (10031, 10008) is `Conflict`. Before, 10002 mapped to `NotFound`, so `exists()` returned `false` on bad credentials, and 10007 (NoSuchKey) mapped to `Conflict`.
