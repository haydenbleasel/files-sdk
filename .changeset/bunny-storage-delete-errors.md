---
"files-sdk": patch
---

`files-sdk/bunny-storage` `delete()` no longer reports success when the Storage API rejects the delete. The SDK's `file.remove()` resolves `false` instead of throwing on 401, 403 and 5xx responses, and the adapter ignored it. A `false` result now probes the key: a missing key is still an idempotent no-op, a probe error surfaces, and a file that still exists throws.
