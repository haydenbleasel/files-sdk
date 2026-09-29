---
"files-sdk": patch
---

`files-sdk/zip`'s `unzip()` now rejects an archive that lists two entries with the same path, as its docs promise. Previously it extracted both, so the second silently overwrote the first.
