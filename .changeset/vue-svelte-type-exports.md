---
"files-sdk": patch
---

`files-sdk/vue` and `files-sdk/svelte` now re-export the `FileVersion`, `TrashedFile` and `NativeFileRef` types, and `files-sdk/react` adds `NativeFileRef`, so all three bindings expose the same client types. The new `UploadManyCallOptions` and `UploadProgressCallback` types are exported from each binding as well.
