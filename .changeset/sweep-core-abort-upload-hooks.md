---
"files-sdk": patch
---

`files.abortUpload()` now reports through the instance hooks like the other write methods. It fires one `onAction` event with `type: "abortUpload"` and the caller's `key` on success and on failure, `onError` when it rejects (including the `ReadOnly`, `Unsupported`, and `Invalid` refusals), and `onRetry` for each retried discard. Before, it bypassed the hooks, so nothing watching `onAction` saw it. `FilesActionType` gains the `"abortUpload"` member. It still isn't a plugin operation, so plugin `wrap`s such as `audit()`, `usage()`, and `tracing()` don't see it.
