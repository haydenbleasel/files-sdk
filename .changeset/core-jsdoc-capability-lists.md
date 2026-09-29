---
"files-sdk": patch
---

Corrected editor docs across `files-sdk`: `list({ delimiter })` now lists Bun's S3 as supported (it no longer throws), `upload({ multipart })` notes that the S3 `fetch` client throws rather than ignoring it, `delete(keys, { concurrency })` names every adapter with a native bulk delete and explains that a wrapping plugin makes the per-key fan-out (and so `concurrency`) apply everywhere, `move()` lists every adapter with a native rename, `capabilities.signedUrl` names the `fs` adapter's `urlBaseUrl` option correctly, and `files-sdk/zip` states its real limit of 65,534 entries (65,535 is the ZIP64 marker the writer refuses).
