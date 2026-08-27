---
"files-sdk": patch
---

A plugin `wrap` that throws a plain `Error` now surfaces to the caller as a `FilesError` regardless of whether `onAction` or `onError` hooks are installed. Previously the hook-free fast path let the raw error escape unwrapped, so `error instanceof FilesError` checks behaved differently depending on the client's hook configuration.
