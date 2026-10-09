---
"files-sdk": patch
---

Fix OIDC authentication in the Vercel Blob adapter (`files-sdk/vercel-blob`) on Vercel Functions. There the OIDC token arrives per request, in the `x-vercel-oidc-token` header, rather than in `process.env`. With an OIDC-only store (`BLOB_STORE_ID` and no `BLOB_READ_WRITE_TOKEN`), `vercelBlob()` threw "missing credentials" at construction even though `@vercel/blob` could authenticate. The adapter now passes the store id and lets `@vercel/blob` find the OIDC token itself, for environment tokens too. So a fresh request-header token wins over a stale `VERCEL_OIDC_TOKEN`, and on `@vercel/blob` 2.5 and later an expired local token from `vercel env pull` is refreshed. An explicit `oidcToken` option is still used as given, and the credential order is unchanged.
