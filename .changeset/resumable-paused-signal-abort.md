---
"files-sdk": patch
---

A paused resumable upload (`upload(key, body, { control })` after `control.pause()`) now rejects when the caller's `signal` (or the constructor `signal`) aborts. Previously the parked upload ignored the signal and the `upload()` promise stayed pending until `resume()` or `control.abort()`. Like any external abort, the session is kept so the upload can still be resumed from `control.toJSON()`, and the pause gate no longer leaves an abort listener on the signal for every pause/resume cycle.
