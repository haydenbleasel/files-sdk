---
"files-sdk": patch
---

The Bunny Storage adapter's `delete()` (`files-sdk/bunny-storage`) now asks `@bunny.net/storage-sdk` to throw on HTTP errors, so it can classify the response status directly. A 401 from a wrong or read-only access key is now reported as `Unauthorized`, with no follow-up probe. Before, it surfaced as a retried `Provider` error saying the file still exists. A 404 is still treated as a successful delete. Other failures stay retryable `Provider` errors. On an SDK version that ignores the option, the previous probe-based behavior applies.
