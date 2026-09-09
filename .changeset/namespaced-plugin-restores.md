---
"files-sdk": patch
---

`softDelete()` and `versioning()` can now be composed on one instance. Both plugins contributed a `restore` extension, so `createFiles({ plugins: [softDelete(), versioning()] })` threw an extension collision at construction (#157). The two restores are now namespaced to match the names the gateway, `FilesClient`, and `useFiles` already use:

- `versioning()`: `files.restore(key, versionId?)` is now `files.restoreVersion(key, versionId?)`.
- `softDelete()`: `files.restore(key)` is now `files.restoreTrashed(key)`.

`versioning()` also gains an `ignore` option, a list of key prefixes that are never snapshotted. Pass the trash prefix when pairing the two plugins - `versioning({ ignore: [".trash"] })` - otherwise a `purge()` (a real delete of the trash key) is snapshotted into `.versions/.trash/…`, a copy nothing lists and nothing reclaims. Place `versioning()` outermost so deletes are snapshotted before they're trashed.
