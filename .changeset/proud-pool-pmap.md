---
"files-sdk": patch
---

The client's bulk upload/download paths now run through `p-map` directly instead of a hand-rolled worker-cursor pool. Results stay in input order and `stopOnError` semantics are unchanged. One edge tightened: a nonsensical `concurrency` (zero, negative, or fractional) now throws p-map's clear `TypeError` instead of being silently clamped to one at a time.
