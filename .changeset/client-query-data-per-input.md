---
"files-sdk": patch
---

The reactive `useFile`, `useList` and `useSearch` in `files-sdk/react` and `files-sdk/vue` no longer show the previous input's `data`. Switching to a new key, prefix, pattern, or endpoint used to keep the old result visible while loading (with `isLoading` false) and next to the new input's error, and a disabled query (`useFile(undefined)`) kept it too. A new input now starts with no data and `isLoading: true`, and a disabled query has no data or error. A `refetch()` of the same input still keeps its data while it reloads, and when the reload fails.
