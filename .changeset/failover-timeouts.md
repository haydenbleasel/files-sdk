---
"files-sdk": patch
---

Fix `failover()` never failing over on timeouts. The docs promised the default predicate covers "network failures, timeouts, and 5xx", but a per-attempt `timeout` surfaces as an `aborted` error, which the predicate excluded — so a hung primary (the canonical case the plugin exists for) surfaced the timeout instead of trying the secondary. `FilesError` now carries a `timedOut` flag (set only by the configured `timeout`, never by a caller's abort signal), and the default predicate fails over on timeouts while still respecting deliberate caller aborts.
