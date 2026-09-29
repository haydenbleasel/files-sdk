---
"files-sdk": patch
---

`files-sdk/pocketbase` `copy()` now overwrites an existing destination key by replacing the file on its record, the same way `upload()` does. Previously it always created a new record, which the collection's unique key index refused, so copying onto an existing key failed with a `Provider` error.
