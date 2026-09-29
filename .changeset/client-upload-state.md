---
"files-sdk": patch
---

Upload state in `files-sdk/client`, `files-sdk/react`, `files-sdk/vue` and `files-sdk/svelte` now always settles. Each file's `FileUploadState` is one object for the whole upload, and it ends `"success"` (keyless and keyed), `"error"` with `state.error` set, or `"aborted"`. `onProgress` fires once more after the terminal status, and bulk `upload([...])` now accepts `onProgress` with one state per item. In the hooks, `uploads` now accumulates one entry per file across every `upload()` call instead of showing only the latest one, and `progress` covers those entries. `reset()` clears the finished entries without zeroing `isUploading` while uploads are still running.
