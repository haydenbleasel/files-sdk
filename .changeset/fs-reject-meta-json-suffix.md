---
"files-sdk": patch
---

fs adapter: reject keys ending in `.meta.json` — the adapter reserves that suffix for its per-object metadata sidecar, and accepting it as a regular key let a same-root caller silently overwrite, hide, or delete another key's sidecar (flipping the served `Content-Type`, mutating arbitrary `metadata` fields, or stripping the etag).
