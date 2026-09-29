---
"files-sdk": patch
---

`files-sdk/client` keyless `upload(file, { contentType })` now honours `contentType`. It used to presign with the file's own `type` and ignore the option.
