---
"files-sdk": patch
---

`files-sdk/audit` now records `error.applied: true` when a conditional mutation committed at the provider and a plugin inside `audit()` then rejected the call. The core marked the error as applied only after it had left the plugin chain, so `audit()` (and any other wrapping plugin) saw a plain failure for a write that had actually landed.
