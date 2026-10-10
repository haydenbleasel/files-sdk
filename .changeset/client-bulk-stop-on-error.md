---
"files-sdk": patch
---

Bulk `upload([...])` and `download([...])` with `stopOnError` in `files-sdk/client` (and the `useFiles` bindings) now behave like the SDK: items run one at a time in input order, and the call resolves at the first failure with `{ results, errors: [thatFailure] }`. They used to reject while sibling items kept running, so writes could land after the call had failed and `isUploading` could read `false` while uploads were still in flight. Items that never started are still reported as `"aborted"` in the upload state.
