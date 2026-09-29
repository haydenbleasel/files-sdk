---
"files-sdk": patch
---

`files-sdk/bunny-storage` now rejects keys containing `.` or `..` path segments (including their `%2e` spellings) with a `Provider` error before calling the Storage API. Previously the Bunny SDK's URL handling resolved those segments away, so `delete(".")` or `delete("a/..")` targeted the storage zone root and `delete("x/.")` the directory `x/` instead of an object.
