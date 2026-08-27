---
"files-sdk": patch
---

Fixed the Vercel Blob adapter resolving the lazy bodies of `head()` and `list()` results with the CDN's error page as file contents when the blob had been deleted or the request was rejected. Those reads now check the response status like `download()` does, throwing `NotFound` on 404 and `Provider` otherwise.
