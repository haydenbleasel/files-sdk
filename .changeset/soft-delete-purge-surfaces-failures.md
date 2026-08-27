---
"files-sdk": patch
---

Fixed `softDelete()`'s whole-trash `purge()` silently swallowing per-key delete failures. It emptied the trash through the bulk `delete`, which collects errors instead of throwing, and discarded the result, so `purge()` resolved while `trashed()` still listed the key. It now removes everything it can and then throws a `FilesError` naming how many objects failed, with the first failure as its `cause`, matching how `purge(key)` already surfaced errors.
