---
"files-sdk": patch
---

`files-sdk/dropbox` and `files-sdk/onedrive` (and `files-sdk/sharepoint`) refresh-token auth now shares one in-flight token exchange. Before, a cold burst of calls sent one token request per call, which risked rate limiting and, with rotating refresh tokens, rejected redemptions. A failed exchange is retried by the next call instead of being replayed.
