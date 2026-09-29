---
"files-sdk": patch
---

`files-sdk/encryption` now marks its refusals and read failures as `permanent`: `url()`, `signedUploadUrl()`, a ranged `download()`, a failed decrypt, a tampered envelope size, and a raw key of the wrong length. Previously they were ordinary `Provider` errors, so a `failover()` placed before the plugin treated them as an outage and re-sent the call to its secondary, which runs without the plugin and minted an upload URL for unencrypted bytes, signed a link to ciphertext, or served raw stored bytes.
