---
"files-sdk": patch
---

A cross-tier `copy()` or `move()` under `files-sdk/tiering` now applies the call's `signal` and `timeout` to the upload into the destination tier, and a `fallback: true` copy or move applies them to the eviction of the destination's stale copy. Previously only the read from the source tier honored them, so a hung destination tier ignored the caller's abort or deadline and could stall the call indefinitely.
