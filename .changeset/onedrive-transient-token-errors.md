---
"files-sdk": patch
---

Keep a throttled, failing, or unreachable Microsoft Entra token endpoint a retryable `Provider` error in the OneDrive and SharePoint adapters (`files-sdk/onedrive`, `files-sdk/sharepoint`) when authenticating with `clientCredentials`. `@azure/identity` reports every failed token request the same way, so a `503` from the token endpoint surfaced as `Unauthorized`: never retried, and never failed over by `failover()`. With `@azure/identity` 4.14 or later the error names its cause, and the adapter now reports a `429`, a `5xx`, or a network failure as `Provider`, as the `oauth` refresh-token flow already did. A rejected client secret is still `Unauthorized`, and older `@azure/identity` versions behave as before. No peer range change.
