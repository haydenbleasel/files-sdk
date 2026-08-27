---
"files-sdk": patch
---

Fixed the Bunny Storage adapter returning a directory listing instead of the file's contents when reading the body of an item returned by `list()` (or `head()`). The lazy body now downloads by the entry's full key rather than relying on the Bunny SDK's `entry.data()`, which fetches the entry's containing directory for listing results.
