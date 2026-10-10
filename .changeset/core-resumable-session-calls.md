---
"files-sdk": patch
---

Resumable uploads in `files-sdk` now open, probe, and finalize their provider session under the same per-attempt `timeout`, caller `signal`, `control.abort()`, and `retries` as each part. Before, a hung session call ignored the timeout and abort, and a transient provider error there failed the upload despite `retries`. A session that opens after its attempt timed out or was aborted is discarded as soon as it lands, and a finalize retry that finds the session already gone now reports that the object may have been committed instead of a misleading "not found". Custom resumable drivers receive an optional `signal` in `begin()`, `probe()`, and `complete()`.
