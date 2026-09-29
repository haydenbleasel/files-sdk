---
"files-sdk": patch
---

`files-sdk/svelte` `useList`, `useFile` and `useSearch` now abort their in-flight request when the last subscriber to their stores goes away. That happens when the component is destroyed or a `$:` block swaps in a new query, which matches how the React and Vue bindings abort on unmount. A synchronous read such as `get(store)` doesn't trigger it. A query aborted this way runs again when something subscribes to it.
