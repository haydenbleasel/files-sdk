---
"files-sdk": patch
---

`files-sdk/compression` now marks its refusals and read failures as `permanent`: `url()`, `signedUploadUrl()`, a ranged `download()`, an unknown stored algorithm, and a failed decompress. Previously they were ordinary `Provider` errors, so a `failover()` placed before the plugin treated them as an outage and re-sent the call to its secondary, which runs without the plugin and minted an upload URL that skips compression or served raw stored bytes.
