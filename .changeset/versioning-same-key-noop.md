---
"files-sdk": patch
---

`versioning()` (`files-sdk/versioning`) no longer snapshots on a `copy` or `move` of a key onto itself. Those change nothing, but each one used to add a version and, with `limit`, prune an older one, so a no-op could destroy history.
