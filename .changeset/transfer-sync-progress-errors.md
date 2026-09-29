---
"files-sdk": patch
---

A throwing `onProgress` callback no longer breaks `transfer()` or `sync()` from `files-sdk`. Progress is now fire-and-forget, as it is for uploads: before, a throw turned every key that had already been copied into a per-key error, and `sync({ prune: true })` rejected after it had already deleted destination keys.
