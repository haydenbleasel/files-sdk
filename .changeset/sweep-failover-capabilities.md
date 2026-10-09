---
"files-sdk": patch
---

`files-sdk/failover` now advertises only what every backend can do. `files.capabilities` reported the primary's flags alone, so an option a secondary can't honor (`range`, `metadata`, `cacheControl`, a `delimiter`) worked while the primary was healthy and started throwing `Unsupported` only once an outage failed the call over. The capabilities are now the primary's intersected with each secondary's (booleans must hold on all of them, the weakest `delimiter` and signed-URL expiry, the tightest `maxExpiresIn`), and the core refuses those options on every call, before any backend is touched, with an error naming the plugin. `capabilities.events` stays the primary's.
