---
"files-sdk": patch
---

`files-sdk/webdav` streamed downloads (`as: "stream"`) no longer report `size: 0` when the server sends a chunked response without a `Content-Length` header. The adapter now takes the size from a `PROPFIND`, narrowed to the requested slice for a ranged read.
