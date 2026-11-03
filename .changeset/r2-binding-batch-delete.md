---
"files-sdk": patch
---

Batch bulk deletes through the R2 Workers binding (`files-sdk/r2`). `delete([...])` in binding and hybrid mode now passes up to 1000 keys to each `R2Bucket.delete()` call instead of making one call per key, with a repeated key sent once. A failed call is reported on every key in its batch, as with the other native bulk deletes.

With a constructor `signal` or `timeout` set, a native bulk `delete([...])` on any adapter now goes out in slices of up to 1000 keys, one at a time, each under its own timeout. The first slice the signal or timeout cuts off, or that fails outright after an earlier slice went through, ends the delete: its keys and those of the slices not yet sent are reported in `errors` instead of rejecting the whole call, and the keys earlier slices deleted stay in `results`. No further slice reaches the adapter, so a cut-off slice still running never overlaps the next.
