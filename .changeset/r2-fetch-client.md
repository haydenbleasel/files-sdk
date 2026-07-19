---
"files-sdk": minor
---

Lightweight `aws4fetch`-powered engine for Cloudflare R2 (#76). `r2({ client: "fetch" })` runs the HTTP adapter on a SigV4-signed `fetch` core (~2.5 KB gzipped, Web Crypto only) instead of `@aws-sdk/client-s3` — no `@aws-sdk/*` installs needed. It covers upload, download (+ ranges), head, exists, delete, list (+ delimiter), server-side copy, presigned `url()`, and `signedUploadUrl()`; multipart/resumable uploads throw with guidance to the default `"aws-sdk"` client, and stream bodies are buffered before the single PUT. Hybrid binding mode (binding + HTTP credentials) now signs `url()` / `signedUploadUrl()` through the same fetch core unconditionally, so binding and hybrid Workers never pull the AWS SDK into their bundle. Adds `aws4fetch` as a regular (tree-shaken, ~2.5 KB) dependency.
