---
"files-sdk": patch
---

`files-sdk/appwrite` `url()` no longer silently ignores `responseContentDisposition`. A bare `"attachment"` now returns the `/download` URL, which Appwrite serves as an attachment; any other value (a custom filename, `inline`) throws, since Appwrite has no per-request override. Ignoring it served user uploads inline even when a download was asked for.
