---
"files-sdk": minor
---

Add `files-sdk/api` — `createFilesRouter`, a server gateway exposing the whole `Files` verb set (upload, download, head, exists, list, search, url, delete, copy, move, capabilities, signed upload URLs) over a single endpoint, with deny-by-default per-operation `authorize` (throw to deny, return a key-prefix/expiry/read-only constraint), redirect-or-proxy streaming downloads (Range/206 + client-disconnect abort), keyless presign→complete uploads with a proxy fallback, HMAC round-trip tokens, and an origin allowlist.
