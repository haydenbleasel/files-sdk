---
"files-sdk": patch
---

`files-sdk/supabase` `copy()` (and so `move()`) now replaces an existing destination. Supabase only overwrites on copy when asked to, so copying or moving onto a key that already existed failed with a `Conflict` error, which also broke re-deleting a key with `softDelete()` and restoring over an existing key. Copies are now sent with `x-upsert: true`.
