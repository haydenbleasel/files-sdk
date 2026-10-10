---
"files-sdk": patch
---

A full (`200`) proxied download from the `files-sdk/api` gateway now carries the object's `size` in its `X-Files-Meta` header, so a client can read the size even when compression middleware drops `Content-Length`. A `206` range response leaves it out.
