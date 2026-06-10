---
"files-sdk": patch
---

Fix `softDelete()` dropping the caller's operation options on the trash move. A `signal`/`timeout`/`retries` passed to `files.delete(key, opts)` was silently ignored for the re-routed move, making the delete un-abortable and unbounded. The options now thread through.
