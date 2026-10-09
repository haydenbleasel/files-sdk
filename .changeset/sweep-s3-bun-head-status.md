---
"files-sdk": patch
---

Classify a 401/403 on `head()`, `exists()`, `download()`, and `copy()` correctly on the Bun S3 adapter (`files-sdk/bun-s3`). Bun's `S3Error` carries no HTTP status and reads the error class from the response body, and a HEAD response has no body, so every failed HEAD other than a 404 arrived as a code-less `UnknownError` and was mapped to a retryable `Provider` error. An access-denied `download()` (which stats first) was retried and then thrown as `Provider`. When Bun reports that, the adapter now presigns the same HEAD and sends it with `fetch` to read the status, so a 401/403 surfaces as `Unauthorized` and isn't retried. A 5xx, or a HEAD that succeeds on the second look, keeps the original retryable error. The extra request happens only on that failure path.
