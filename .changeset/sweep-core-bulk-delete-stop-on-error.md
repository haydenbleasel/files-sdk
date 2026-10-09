---
"files-sdk": patch
---

`files.delete(keys, { stopOnError: true })` now gives the same result with or without plugins when one of the keys is invalid. Without plugins it used to validate every key before deleting any, so `["a", "", "b"]` returned `{ results: [] }` and left `a` in place, while the plugin path deleted `a` and then stopped. Both paths now go key by key in order, validating each key only when its turn comes, so `a` is deleted, the run stops at `""` with an `Invalid` error, and `b` is never attempted. This is the same order `upload([...], { stopOnError: true })` already used.
