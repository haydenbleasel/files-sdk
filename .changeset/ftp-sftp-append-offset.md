---
"files-sdk": patch
---

Fix silent file corruption in FTP/SFTP resumable uploads when a chunk is retried. `uploadAt()` appended at the server-side EOF without consulting the chunk's `offset`, so a per-chunk retry after a partial append — or after a lost success reply — appended the chunk again, leaving duplicated bytes in the middle of the file while the upload "succeeded". The drivers now verify the remote size matches the expected offset before appending and, on a mismatch, skip the write and report the server's real offset so the orchestrator re-slices from there.
