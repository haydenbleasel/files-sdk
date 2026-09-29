---
"files-sdk": patch
---

`files-sdk/dedup` no longer forwards `control` and `multipart` to the pointer write. An `UploadControl` drives exactly one upload, so passing one to `upload()` threw on the pointer write after the blob had landed; `control` and `multipart` now apply to the blob write only, and when the content is already stored no bytes move and the control is left undriven.
