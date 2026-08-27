---
"files-sdk": patch
---

Fix `onedrive()` (and therefore `sharepoint()`) streaming downloads throwing `ERR_INVALID_ARG_TYPE` in every real runtime. The Graph client resolves `ResponseType.STREAM` with the fetch Response body, which is already a web `ReadableStream`, and the adapter was unconditionally passing it through `Readable.toWeb()`. It now only converts when the client actually hands back a Node `Readable`.
