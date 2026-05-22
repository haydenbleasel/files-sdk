---
"files-sdk": minor
---

Add `hooks` to `new Files(...)` so applications can observe SDK activity with `onAction`, `onError`, and `onRetry`.

Hook payloads expose the public operation type, caller-facing keys, internal adapter paths, timing data, sanitized options, and the final result or error for each operation.
