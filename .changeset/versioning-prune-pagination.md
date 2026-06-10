---
"files-sdk": patch
---

Fix `versioning()`'s prune reading only the first list page. Once a key's history exceeded one provider page, `items.length <= max` could be satisfied by a partial page and pruning was skipped or under-counted, so the configured `limit` wasn't enforced promptly. Prune now paginates the version directory to exhaustion, like `versions()` does.
