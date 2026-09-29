---
"files-sdk": patch
---

Bulk `download([...])` now validates a byte range that a plugin injects into an item, exactly like a single `download()`. A malformed range, or any range on an adapter without range support, is reported as that item's error instead of being passed to the adapter, which could silently return the whole object.
