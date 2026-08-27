---
"files-sdk": patch
---

Fix `azure()` `copy()` and `move()` failing with `CannotVerifyCopySource` in SAS-token mode. The service client is built with the SAS in its URL and the SDK carries that query through to every blob URL, so the adapter was appending the token a second time (`?sv=…?sv=…`). The copy source now reuses the SAS already present on the blob URL.
