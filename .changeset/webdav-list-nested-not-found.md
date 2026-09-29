---
"files-sdk": patch
---

`files-sdk/webdav` `list()` no longer comes back empty when a subcollection disappears partway through the recursive walk: that collection is skipped and the rest is listed, while a missing root still lists as empty.
