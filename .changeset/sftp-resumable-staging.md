---
"files-sdk": patch
---

`files-sdk/sftp` resumable uploads (`upload({ control })`) now append to a `<key>.fls-part` staging file and rename it over the key when the upload completes. They used to write straight to the key: starting an upload deleted the existing file, a paused or crashed upload left a truncated file readable under the key, and `abort()` deleted the key. `list()` hides staging files, and writes to keys ending in `.fls-part` now throw.
