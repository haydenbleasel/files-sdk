---
"files-sdk": patch
---

Fixed `versioning()` destroying the version being restored when a `limit` is set. `restore()` snapshots the current bytes first, and that snapshot could push the oldest kept version past the limit; the plugin pruned it before copying it back, so the restore failed with `NotFound` and the version was gone for good (with `limit: 1` no restore ever worked). Copies and moves now enforce the limit only after the operation has landed, so restoring the oldest kept version succeeds and the pre-restore bytes take the freed slot.
