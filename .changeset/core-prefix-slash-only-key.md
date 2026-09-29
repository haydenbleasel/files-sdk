---
"files-sdk": patch
---

A `Files` instance with a `prefix` now rejects a key made only of slashes (`"/"`, `"//"`) with the usual "key must be a non-empty string" error. Before, the leading slashes were stripped to an empty key, so `upload("/", body)` wrote the prefix's own `prefix/` folder-marker object.
