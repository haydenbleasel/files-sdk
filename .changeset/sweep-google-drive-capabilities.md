---
"files-sdk": major
---

The Google Drive adapter (`files-sdk/google-drive`) now declares its capabilities honestly. `capabilities.cacheControl` is now `false`. Drive never serves a stored Cache-Control, and the adapter only kept the value in a private appProperty nothing read, so `upload({ cacheControl })` is now refused with `Unsupported` before any Drive call instead of being dropped. `capabilities.signedUpload.contentType` is now `true`, because `signedUploadUrl({ contentType })` binds the type when the session starts (`X-Upload-Content-Type` sets the file's MIME type). With a pre-built `client`, which has no auth handle to mint session tokens, the adapter no longer attaches a `resumableUpload` driver that always threw. `capabilities.resumable` is now `false` in that case, and `upload({ control })` is refused up front with the core `Unsupported` error.
