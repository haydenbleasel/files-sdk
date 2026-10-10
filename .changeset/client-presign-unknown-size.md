---
"files-sdk": patch
---

A keyless `upload()` from `files-sdk/client` (and the `useFiles` bindings) of a React Native file reference without a `size` now works. The client used to declare such a file's size as `0`, and since the gateway holds an upload to its declared size, the upload was refused. The client now leaves `size` out of the presign request when it doesn't know it, so the gateway applies only its `maxUploadSize`.
