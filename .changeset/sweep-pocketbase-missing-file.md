---
"files-sdk": patch
---

When a PocketBase record has no file in the configured `fileField`, the PocketBase adapter (`files-sdk/pocketbase`) now throws `Invalid` from `download()`, `head()`, and `url()` instead of a retryable `Provider` error. The usual cause is a `fileField` that doesn't name the collection's single-file field, and fetching the same record again can only fail the same way. The message now says to check `fileField`.
