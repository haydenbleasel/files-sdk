---
"files-sdk": patch
---

`files-sdk/dedup` now refuses writes into its content store through the instance: an `upload()`, `signedUploadUrl()`, or a `copy()` / `move()` whose destination is inside the store prefix (`.dedup/` by default) throws a permanent `FilesError`. Previously any caller who could write a key could overwrite `.dedup/<sha256>` and change what every pointer to that content returned. Reads of the store and deleting a blob (for a garbage-collection sweep) still pass through.
