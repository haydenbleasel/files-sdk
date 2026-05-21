---
"files-sdk": patch
---

fs adapter: reject keys that resolve to a `.meta.json` sidecar path — the adapter reserves that suffix for its per-object metadata sidecar, and accepting it as a regular key let a same-root caller silently overwrite, hide, or delete another key's sidecar (flipping the served `Content-Type`, mutating arbitrary `metadata` fields, or stripping the etag). The check runs on the resolved basename and folds case plus Windows trailing dots/spaces, so re-cased or normalized variants (`x.META.JSON`, `x.meta.json.`, `x.meta.json/`) that alias the sidecar on case-insensitive (APFS/NTFS) or Windows volumes are rejected too.
