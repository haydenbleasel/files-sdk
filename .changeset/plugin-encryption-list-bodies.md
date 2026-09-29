---
"files-sdk": patch
---

`list()` items under `files-sdk/encryption` now return plaintext from their body accessors on adapters whose listing carries no object metadata, such as S3 and the S3-compatible adapters. Without the envelope marker in the listing the plugin passed those items through untouched, so `text()`, `arrayBuffer()`, `blob()` and `stream()` returned the stored ciphertext; they now download the object back through the plugin and decrypt it. Such items still report the stored size, since the plaintext size lives in metadata the listing doesn't include.
