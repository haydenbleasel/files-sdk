---
"files-sdk": patch
---

Preserve the caller's query string on gateway-minted proxy upload targets, so a per-request `files` factory selected via the endpoint query (e.g. `useFiles({ endpoint: "/api/files?bucket=images" })`) resolves the same instance across the presign/proxy/complete round-trip.
