---
"files-sdk": patch
---

`files-sdk/supabase`'s `signedUploadUrl()` now throws on a positive `minSize` instead of silently ignoring it, because Supabase signed upload URLs have no minimum-size constraint. `minSize: 0` is still accepted.
