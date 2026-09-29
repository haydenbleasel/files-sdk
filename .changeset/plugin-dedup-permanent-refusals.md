---
"files-sdk": patch
---

`files-sdk/dedup` now marks its `url()` and `signedUploadUrl()` refusals as `permanent`. Previously they were ordinary `Provider` errors, so a `failover()` placed before the plugin treated them as an outage and re-sent the call to its secondary, which runs without the plugin and minted a URL that bypasses content-addressing.
