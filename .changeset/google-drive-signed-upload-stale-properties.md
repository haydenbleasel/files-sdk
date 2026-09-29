---
"files-sdk": patch
---

`files-sdk/google-drive`'s `signedUploadUrl()` on an existing key now clears the previous upload's stored content type, `cacheControl`, and metadata. Drive merges `appProperties` on update, so `head()` kept reporting the old content type after the new bytes landed.
