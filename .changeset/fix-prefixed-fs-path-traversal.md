---
"files-sdk": patch
---

Reject `.` and `..` segments in `Files` prefixes and prefixed keys before resolving local filesystem paths, so prefixed fs adapters cannot escape their configured root.
