---
"files-sdk": patch
---

`files-sdk/bun-s3`: a resumable upload (`control`) no longer fails after its final write has landed because the follow-up `stat()` was refused or failed. The stat only fills in the result's `etag` and `lastModified`, so a key allowed `PutObject` but not `HeadObject` now gets the upload result without them, as a plain `upload()` already did, instead of an error whose retry wrote the whole body again and left the buffered session in memory.
