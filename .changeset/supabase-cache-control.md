---
"files-sdk": patch
---

`files-sdk/supabase` now sends `cacheControl` the way Supabase expects it, as a number of seconds. Previously a header like `"public, max-age=60"` was stored as `max-age=public, max-age=60`. A `max-age=<n>` value (optionally with `public`) or a bare number of seconds is accepted; values Supabase can't store, such as `no-store` or `immutable`, now throw instead of being mangled.
