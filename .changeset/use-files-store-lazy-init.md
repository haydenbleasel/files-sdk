---
"files-sdk": patch
---

Fix `useFiles` recreating its internal store on every render. The store is now initialized lazily once (matching the abort-controller ref pattern), avoiding the wasted `createStore()` call and throwaway allocation on each render.
