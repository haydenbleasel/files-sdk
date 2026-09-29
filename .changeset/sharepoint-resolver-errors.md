---
"files-sdk": patch
---

`files-sdk/sharepoint` now classifies Graph errors from its site and drive lookups like every other Graph error: 401/403 map to `Unauthorized` and 404 to `NotFound`. They surfaced as retryable `Provider` errors before.
