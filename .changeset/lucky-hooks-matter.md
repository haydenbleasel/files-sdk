---
"files-sdk": minor
---

Add `hooks` to `new Files(...)` so applications can observe SDK activity with `onAction`, `onError`, and `onRetry`.

Each hook is fire-and-forget (called, not awaited) and receives a small, caller-facing event — the operation `type`, the public `key` / `keys` (or `from` / `to` for `copy`), timing, and the final result or error. It mirrors the lightweight `onProgress` callback style.
