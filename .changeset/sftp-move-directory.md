---
"files-sdk": patch
---

`files-sdk/sftp` `move()` now throws `NotFound` when the source key is a directory instead of renaming the whole directory tree, and a missing source no longer leaves the destination's parent folder behind.
