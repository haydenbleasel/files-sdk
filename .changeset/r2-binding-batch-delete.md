---
"files-sdk": patch
---

Batch bulk deletes through the R2 Workers binding (`files-sdk/r2`). `delete([...])` in binding and hybrid mode now passes up to 1000 keys to each `R2Bucket.delete()` call instead of making one call per key. A failed call is reported on every key in its batch, as with the other native bulk deletes.
