---
"files-sdk": patch
---

`files --provider supabase` now passes `--public-base-url` through to the adapter, so `url()` returns `<publicBaseUrl>/<key>` as the flag's help text describes. Previously the flag was silently dropped for Supabase.
