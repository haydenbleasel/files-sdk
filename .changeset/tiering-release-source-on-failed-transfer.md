---
"files-sdk": patch
---

`files-sdk/tiering` now cancels the source stream when a cross-tier `copy`, `move`, or `tier()` fails to upload to the destination tier. The streamed source download was left unread, so every failed transfer (a cold tier that is down, a timeout) kept a connection to the source tier open.
