---
"files-sdk": minor
---

Expose the `versioning()` and `softDelete()` plugin verbs through the gateway, client and `useFiles` hook. `createFilesRouter` now dispatches `versions` / `restoreVersion` / `trashed` / `restoreTrashed` / `purge` (each a new deny-by-default `FilesOperation`, answered only when the matching plugin wraps the `Files` instance — otherwise a 422), and `createFilesClient` / `useFiles` gain matching methods (`files.versions(key)`, `files.restoreVersion(key, versionId?)`, `files.trashed()`, `files.restoreTrashed(key)`, `files.purge(key?)`). Trash listing and "empty trash" are key-prefix-scoped, so a multi-tenant `authorize` keyPrefix never leaks or purges another tenant's trash.
