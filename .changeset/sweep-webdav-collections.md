---
"files-sdk": patch
---

The WebDAV adapter (`files-sdk/webdav`) no longer runs recursive operations on a collection. WebDAV `DELETE`, `COPY`, and `MOVE` on a collection act on everything under it, so `files.delete("photos")` used to delete `photos/**` even though `head("photos")` reported `NotFound`. `delete()` now checks the key first and is a no-op for a collection, the same as for a missing key. `copy()` and `move()` refuse a collection source with `NotFound`. They also refuse a collection destination with `Conflict`, because `Overwrite: T` would replace the whole collection with one file. Each of these operations now costs one extra `PROPFIND`. The `root` option docs now say that escaping keys throw `Invalid`.
