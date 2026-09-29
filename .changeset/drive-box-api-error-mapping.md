---
"files-sdk": patch
---

`files-sdk/box` now classifies Box API errors by their HTTP status again: 404 maps to `NotFound`, 401/403 to `Unauthorized`, and 409/412 to `Conflict`. The Box SDK's ESM build, which is what an `import` loads, drops `responseInfo` from every `BoxApiError`, so each one surfaced as a retryable `Provider` error. The status is now read from the error message the SDK formats. Where `responseInfo` is intact, the adapter now reads the raw Box error code from the response body, since the copy in `responseInfo.code` is JSON-quoted and never matched. A rejected OAuth grant (`invalid_grant`, `invalid_client`) now maps to `Unauthorized`.
