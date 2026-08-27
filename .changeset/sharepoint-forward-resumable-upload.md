---
"files-sdk": patch
---

Fix `sharepoint()` not supporting resumable uploads even though the underlying OneDrive adapter does: `upload(key, body, { control })` threw an unsupported-operation error and `files.capabilities.multipart` reported `false`. The wrapper now forwards `resumableUpload` to the inner Graph upload-session driver, created lazily after site and drive resolution like every other verb.
