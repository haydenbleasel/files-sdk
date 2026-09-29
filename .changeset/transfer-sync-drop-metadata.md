---
"files-sdk": patch
---

`transfer()` and `sync()` from `files-sdk` now drop user metadata when the destination can't store it (`dest.capabilities.metadata` is `false`), as their docs describe. Before, every metadata-bearing object failed with a "`metadata` is not supported" per-key error when copying to an adapter such as WebDAV, Dropbox, or Bunny Storage.
