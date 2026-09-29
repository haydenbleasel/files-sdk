---
"files-sdk": patch
---

`files-sdk/validation` now marks every `ValidationError`, and its `signedUploadUrl()` refusal, as `permanent`. Previously they were ordinary `Provider` errors, so a `failover()` placed before the plugin treated a rejected write as an outage and re-sent it to its secondary, which runs without the plugin, storing an upload that broke the size, type, or key rule.
