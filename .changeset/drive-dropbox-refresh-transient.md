---
"files-sdk": patch
---

`files-sdk/dropbox` now treats a throttled (429) or failing (5xx) token endpoint during a refresh-token exchange as a retryable `Provider` error. It used to throw `Unauthorized`, so a transient outage of Dropbox's OAuth endpoint was never retried. A rejected refresh token still maps to `Unauthorized`.
