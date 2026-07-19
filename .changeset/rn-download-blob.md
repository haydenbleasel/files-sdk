---
"files-sdk": patch
---

`StoredFile.blob()` now works on React Native. RN's `Blob` cannot be constructed from raw bytes, so `blob()` on a downloaded file threw at Blob construction — the exact platform the RN client work targets. On runtimes without byte-part Blobs, `blob()` now consumes the response's native `Response.blob()` instead, and later `text()`/`arrayBuffer()` calls read back through that Blob (via `Blob#arrayBuffer()` or `FileReader`). If bytes were already materialized first, `blob()` throws a clear `FilesError` explaining the ordering instead of an opaque platform error.
