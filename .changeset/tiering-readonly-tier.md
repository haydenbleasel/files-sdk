---
"files-sdk": patch
---

`files.tier()` from `files-sdk/tiering` now throws `ReadOnly` on a read-only instance (`files.readonly()` or `readonly: true`) instead of moving and deleting data. `Files` exposes a new `isReadOnly` getter so plugins whose `extend` methods write through an internal instance can refuse the same way. The `tier()` docs now note that its moves bypass hooks and the instance's other plugins.
