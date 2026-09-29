---
"files-sdk": patch
---

`files-sdk/google-drive` built with `publicByDefault` now grants the `anyone, reader` permission in `url()` before returning the link. Only a plain `upload()` used to grant it, so after `copy()`, a resumable upload, or a client upload through `signedUploadUrl()`, `url()` returned a link that asked for a Google sign-in.
