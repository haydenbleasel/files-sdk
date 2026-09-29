---
"files-sdk": patch
---

`files-sdk/zip`'s `unzip()` now reports an entry that inflates past its declared size as a corrupt archive. Previously it blamed "the configured unzip size limit", even though the entry was far under `maxEntrySize` and the archive's own header was what lied.
