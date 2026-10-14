---
"files-sdk": patch
---

Interrupting a buffered `DownloadedFile` read in `files-sdk/effect` (`text`, `arrayBuffer`, or `blob`) now cancels the body read underneath, instead of leaving it running after the fiber stops waiting. The read is cancelled only once no other read is waiting on the same body, so a plain `StoredFile` read in progress is never cut short, and later reads of a cancelled body fail as an `aborted` (never retried) `Provider` error. Bodies downloaded through the `usage()` plugin stay cancellable. Resolves #173.
