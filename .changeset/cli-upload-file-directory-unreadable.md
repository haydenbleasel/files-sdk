---
"files-sdk": patch
---

`files upload --file` now checks its source before the upload starts: a directory fails with `Invalid` (exit 2) and points at `--dir`, and a file the process can't read fails as a local file error (exit 2). Both used to surface from inside the adapter's upload with whatever code that adapter gives a read error; on `fs` that was `Conflict` (exit 4) for a directory and `Unauthorized` (exit 3) for an unreadable file.
