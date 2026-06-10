---
"files-sdk": patch
---

Fix `usage()` miscounting `bytesDown` for buffer-backed bodies read via `stream()`. The wrapper eagerly marked `stream()` as counted, which only holds for read-once stream sources — buffer-backed files (the memory adapter, or anything a transforming plugin buffered) have a repeatable `stream()`, so reading one twice double-counted, and opening a stream without reading it zeroed out the count of a later `text()`/`arrayBuffer()` that actually moved the bytes. The count is now claimed by the first read channel that actually moves bytes, at most once per body.
