---
"files-sdk": patch
---

`files-sdk/content-type` now marks its `onMismatch: "reject"` and `onUnknown: "reject"` rejections, and its `signedUploadUrl()` refusal, as `permanent`. Previously they were ordinary `Provider` errors, so a `failover()` placed before the plugin treated a rejected upload as an outage and re-sent it to its secondary, which runs without the plugin, storing the mislabeled upload anyway.
