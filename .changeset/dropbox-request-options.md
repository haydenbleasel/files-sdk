---
"files-sdk": minor
---

The Dropbox adapter (`files-sdk/dropbox`) now forwards the abort signal to every Dropbox API request. Cancelling a call, or hitting its `timeout`, aborts the in-flight upload, download, listing, copy, delete, metadata, link, or resumable-chunk request instead of letting it run to completion in the background. This uses the SDK's per-request transport options (`dropbox` 10.42 and later); older versions ignore them and behave as before.

Buffered uploads over Dropbox's 150 MB single-call limit now use a concurrent upload session when `dropbox` 10.47 or later is installed: `multipart.concurrency` chunks (default 4, matching the S3 adapter) upload in parallel through the SDK's new `uploadFile` helper, with retries left to the `Files` wrapper's `retries` and `onRetry`. Pass `multipart: { concurrency: 1 }` to keep the sequential session. Stream bodies and resumable uploads stay sequential, and older `dropbox` versions keep the sequential session for every upload. The peer range is unchanged.
