---
"files-sdk": patch
---

Core fixes:

- A plugin that only declares `capabilities` is now enforced like one that also wraps.
- `delete(keys, { stopOnError: true })` goes key by key with or without plugins, so both return the same result.
- `abortUpload()` fires `onAction`, `onError`, and `onRetry` (`type: "abortUpload"`), and rejects when the provider refuses the cancel (GCS, Firebase Storage, Google Drive, OneDrive, SharePoint, Supabase) instead of reporting success.
- `sync({ prune: true, signal })` stops pruning once the signal aborts.
- A plugin's `extend` can no longer replace a symbol-keyed `Files` member.
