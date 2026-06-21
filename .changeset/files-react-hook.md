---
"files-sdk": minor
---

Add the `useFiles` app layer: a full Files-API parity hook for the browser over one HTTP endpoint.

- `files-sdk/api` — `createFilesRouter`, a server gateway exposing the whole `Files` verb set (upload, download, head, exists, list, search, url, delete, copy, move, capabilities, signed upload URLs) over a single endpoint, with deny-by-default per-operation `authorize` (throw to deny, return a key-prefix/expiry/read-only constraint), redirect-or-proxy streaming downloads (Range/206 + client-disconnect abort), keyless presign→complete uploads with a proxy fallback, HMAC round-trip tokens, and an origin allowlist.
- `files-sdk/client` — `createFilesClient`, a framework-agnostic verb client; `download` returns the same lazy `StoredFile` the server SDK returns.
- `files-sdk/react` — `useFiles({ endpoint })` returning every verb (imperative, with ambient upload progress/error) plus optional reactive `useList`/`useFile`/`useSearch` hooks. Emitted as a `"use client"` module.
- `files-sdk/next` — `createRouteHandler` to mount the gateway in the Next.js App Router.
