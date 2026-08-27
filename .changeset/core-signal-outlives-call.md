---
"files-sdk": patch
---

A caller-supplied `signal` now keeps reaching a lazily-streamed body after the operation call has resolved. Previously, when a `timeout` was configured or a per-call signal was combined with the client's constructor signal, the SDK minted a merged signal and detached it from its sources as soon as the adapter call settled, so aborting the caller's signal no longer interrupted a `download()` body still being read. Caller signals are now folded with `AbortSignal.any` (with a manual fallback on older runtimes) and stay wired for the life of the operation, while only the per-attempt timeout timer is disarmed once the call resolves, so a timeout still never cuts off a body that is streaming after the call succeeded.
