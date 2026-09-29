---
"files-sdk": patch
---

`files upload <key>` in the `files` CLI now infers the content type from the key's extension when `--content-type` isn't given, as `upload --dir` already did per file. Single-key uploads previously stored `application/octet-stream` for everything. `--dry-run` echoes the resolved type.
