---
"files-sdk": major
---

The `files-sdk/api` gateway now keeps plugin storage out of reach of the core verbs. On an instance with `versioning()` or `softDelete()`, a client key or `list`/`search` prefix inside the version store (`.versions/` by default) or the trash (`.trash/`) is refused with a 403 (`Forbidden`), so a gateway that allows `delete` but not `purge` can no longer hard-delete a trashed object, and no client can list or wipe version history or upload a forged version. A `search` whose glob walks into either prefix matches nothing there. Under an authorize `keyPrefix`, a tenant's own folders with those names (`users/42/.trash/…`) stay ordinary keys. `files-sdk/versioning` and `files-sdk/soft-delete` mark their prefixes on the instance for this, including on a `files.readonly()` view.
