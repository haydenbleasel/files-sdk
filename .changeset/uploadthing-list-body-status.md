---
"files-sdk": patch
---

Fixed the UploadThing adapter resolving the lazy bodies of `list()` items with an error page as file contents when the file had been deleted or the request was rejected. Those reads now check the response status like `download()` and `head()` do, throwing `NotFound` on 404 and `Provider` otherwise.
