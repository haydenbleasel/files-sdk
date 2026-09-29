---
"files-sdk": patch
---

Resumable uploads (`upload({ control })`) on `files-sdk/supabase` now carry `cacheControl` and user `metadata` into the TUS session instead of dropping them. Chunks also stay at the 6 MiB size Supabase requires, so a `multipart.partSize` no longer breaks the upload.
