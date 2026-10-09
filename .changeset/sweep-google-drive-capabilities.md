---
"files-sdk": major
---

The Google Drive adapter (`files-sdk/google-drive`) now refuses `upload({ cacheControl })` with `Unsupported` (`capabilities.cacheControl` is `false`): Drive never serves it, and the value was silently dropped. It also declares `signedUpload.contentType: true`, since the session binds the type, and no longer offers resumable uploads when built from a pre-built `client`, where they always threw.
