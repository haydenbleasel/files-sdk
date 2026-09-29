---
"files-sdk": patch
---

`files-sdk/vue` and `files-sdk/svelte` now mirror failures from `versions`, `restoreVersion`, `trashed`, `restoreTrashed` and `purge` into `error`, as `files-sdk/react` already did. All three bindings now also record errors thrown while iterating `listAll()` or `search()`.
