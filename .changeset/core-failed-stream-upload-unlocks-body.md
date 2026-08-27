---
"files-sdk": patch
---

A failed `ReadableStream` upload with `onProgress` no longer leaves the caller's stream locked. The progress-counting wrapper now acquires its reader lazily on first pull, and on failure the SDK cancels the wrapper so the source stream's `cancel` runs and `body.locked` is `false` afterward. Previously the reader was grabbed eagerly, so an adapter that failed before reading a byte left the caller unable to cancel or reuse their stream.
