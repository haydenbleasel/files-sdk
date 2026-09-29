---
"files-sdk": patch
---

`files.zip(selection)` from `files-sdk/zip` no longer starts listing or downloading until the returned stream is first read, as documented. The stream used to pull one chunk eagerly, so creating an archive stream you never consumed still listed the selection and opened the first download. The `unzip` `maxEntries`, `maxEntrySize`, and `maxTotalSize` options are now documented in the type definitions.
