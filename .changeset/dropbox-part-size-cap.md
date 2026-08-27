---
"files-sdk": patch
---

The Dropbox adapter now caps `multipart.partSize` at the 150 MB per-request limit of Dropbox upload sessions (rounded down to the required 4 MiB multiple, so 148 MiB). Previously a larger `partSize` was rounded but never capped, producing session appends the API rejects.
