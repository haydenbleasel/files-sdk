---
"files-sdk": patch
---

A `timeout` of `Infinity` (or any value past the 32-bit `setTimeout` limit) no longer aborts every operation after about a millisecond with "Operation timed out after Infinityms". Non-finite timeouts now mean "no timeout", and finite values beyond the limit are clamped to it, consistently across single operations, bulk calls, and resumable-upload chunks.
