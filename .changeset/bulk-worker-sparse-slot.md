---
"files-sdk": patch
---

Fix the bulk worker pool dying on a sparse/`undefined` array slot. The per-worker guard `return`ed instead of skipping the slot, so with `concurrency: 1` (or as many holes as workers) every key after the hole was silently neither processed nor reported in `results`/`errors`. Only reachable past the type system (a sparse array or an `undefined` element cast in), but the recovery is now to skip just that slot.
