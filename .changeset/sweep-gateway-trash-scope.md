---
"files-sdk": patch
---

`trashed` and a scoped `purge` on the `files-sdk/api` gateway now read only the caller's own part of the trash. Under an authorize `keyPrefix`, the gateway asks `softDelete()` for just that prefix instead of listing every tenant's trashed objects and filtering them afterwards. `files-sdk/soft-delete`'s `trashed()` accepts the matching option: `trashed({ prefix: "users/42/" })` lists only what was deleted from under that prefix, and walks only that part of the trash.
