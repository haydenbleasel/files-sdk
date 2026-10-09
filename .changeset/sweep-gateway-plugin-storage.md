---
"files-sdk": major
---

The `files-sdk/api` gateway now refuses client keys and `list`/`search` prefixes inside the `versioning()` store (`.versions/`) or the `softDelete()` trash (`.trash/`) with a 403, so a client can't hard-delete trashed objects, wipe version history, or forge versions through the core operations. Use the plugin operations instead. Under an authorize `keyPrefix`, a tenant's own folders with those names stay ordinary keys.
