---
"files-sdk": patch
---

`files.events.webhook()` (`files-sdk/events`) now checks a `verify: { token }` or `verify: { google }` credential before reading the request body. It used to buffer the whole body first, so a sender with no valid credential could make the endpoint hold an arbitrarily large request in memory before getting its `401`.
