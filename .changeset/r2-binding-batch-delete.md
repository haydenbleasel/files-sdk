---
"files-sdk": patch
---

Batch bulk deletes through the R2 Workers binding (`files-sdk/r2`). `delete([...])` in binding and hybrid mode now passes up to 1000 keys to each `R2Bucket.delete()` call instead of making one call per key, with a repeated key sent once. A failed call is reported on every key in its batch, as with the other native bulk deletes.

With a constructor `signal` or `timeout` set, a native bulk `delete([...])` on any adapter now goes out in slices of up to 1000 keys, each under its own timeout. A slice the signal or timeout cuts off is reported on each of its keys in `errors` instead of rejecting the whole call, and once the signal aborts no further slice reaches the adapter.
