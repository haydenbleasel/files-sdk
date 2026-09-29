---
"files-sdk": patch
---

The `files-sdk/soft-delete` docs now describe what is trashed accurately: only deletes made through the `Files` instance. Overwrites (including presigned uploads) and deletes made directly against the provider are not; use `versioning()` to keep overwritten bytes.
