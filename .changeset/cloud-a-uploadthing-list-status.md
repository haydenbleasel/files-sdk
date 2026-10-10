---
"files-sdk": patch
---

`files-sdk/uploadthing` `list()` now returns only files that finished uploading. It also returned files UploadThing reported as still uploading, failed, or pending deletion, which can't be downloaded. Pagination is unchanged: the cursor still advances past every row UploadThing returned.
