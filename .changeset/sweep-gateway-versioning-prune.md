---
"files-sdk": patch
---

`files-sdk/versioning` no longer evicts history when a write fails. With a `limit`, an `upload` or `delete` used to snapshot the current object and prune the oldest versions before the write ran, so a failing write still pushed out a real version (two failed uploads with `limit: 2` left only copies of the current bytes). Pruning now happens only after the write lands, as it already did for `copy` and `move`; a failed write can leave history one snapshot over the limit until the next successful write prunes it.
