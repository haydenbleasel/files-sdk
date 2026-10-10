---
"files-sdk": patch
---

`upload()` in `files-sdk` now rejects a `multipart.partSize` or `multipart.concurrency` that isn't a positive integer with an `Invalid` error before any request, on every upload path (single, bulk, and resumable). Before, a fractional or non-positive value could spin a resumable upload in an endless loop that starved the event loop, silently drop the last byte on Azure, or commit an empty object. The resumable orchestrator also refuses to finalize a part list that doesn't add up to the whole body, and fails a chunk the provider acknowledges without advancing instead of re-sending it forever.
