---
"files-sdk": patch
---

`files-sdk/sftp` `list()` no longer comes back empty when a subdirectory disappears partway through the recursive walk: that directory is skipped and the rest is listed, while a missing root still lists as empty.
