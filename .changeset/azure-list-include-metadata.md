---
"files-sdk": patch
---

Fix `azure()` `list()` never returning blob `metadata` on its items. Azure only includes metadata in listing responses when explicitly asked, so the adapter now passes `includeMetadata: true` to both flat and hierarchical listings.
