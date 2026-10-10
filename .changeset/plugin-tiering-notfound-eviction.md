---
"files-sdk": patch
---

`files-sdk/tiering` with `fallback: true` now works over tiers whose `delete` throws `NotFound` for a missing key, as GCS and Firebase do. The plugin's cleanup deletes assumed a missing key was a no-op, so every first upload rejected with `NotFound` after it had landed, a `copy` or `move` rejected after landing, and a `delete` of a key held by the other tier threw before reaching it, leaving the object in place. Those cleanup deletes now ignore `NotFound`; a `delete` removes the key from whichever tier holds it, and throws `NotFound` only when both tiers report the key missing.
