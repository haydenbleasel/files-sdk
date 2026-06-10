---
"files-sdk": patch
---

Fix the Google Drive adapter creating a duplicate file on every overwrite. Drive has no unique-name constraint and the adapter always called `files.create`, so uploading an existing key a second time left two files carrying the same virtual key — from then on every `head`/`download`/`delete`/`url` on that key from a fresh instance threw `Conflict` (the writer's own id cache masked it). Writes now look the key up first: `upload()` updates the existing file in place, `copy()` deletes the clobbered destination file after a successful copy, and resumable uploads / `signedUploadUrl()` initiate `PATCH` update sessions against the existing file id instead of creating a new one.
