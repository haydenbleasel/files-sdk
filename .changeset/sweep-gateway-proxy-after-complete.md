---
"files-sdk": patch
---

The `files-sdk/api` proxy upload no longer accepts more bytes for an upload that `complete` has already accepted. With a `completions` store configured, a second `PUT` to the same proxy URL now gets a 409 (`Conflict`) instead of silently replacing the object `onUploadComplete` approved (and a replayed `complete` answering with the stale record). If the store can't be read, the proxy refuses the upload rather than risk it. Without a store the gateway is stateless and the proxy token stays writable until it expires, like a presigned URL. The proxy also now refuses a token minted for a direct-to-storage target, so `onUploadComplete`'s `via` always reports how the bytes actually arrived. `files-sdk/client` now reports the proxy's own error (a 409, or a 422 over the size cap) under its code instead of a generic `Provider` failure.
