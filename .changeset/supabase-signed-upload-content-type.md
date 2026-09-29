---
"files-sdk": patch
---

`signedUploadUrl({ contentType })` on `files-sdk/supabase` now throws. Supabase signed upload URLs don't bind a Content-Type, so the header it returned was advisory only. Restrict types with the bucket's allowed MIME types, or validate at your gateway.
