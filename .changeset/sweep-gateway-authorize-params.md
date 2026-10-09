---
"files-sdk": patch
---

The `files-sdk/api` gateway now tells `authorize` what the client declared for an upload. For a keyless upload (`presign`), `params` carries `files` (each file's `name`, `size`, and `type`) and the requested `expiresIn`; for a keyed `PUT ?op=upload`, it carries the request's `contentType` and `size` (from `Content-Length`). Both are advisory, since the gateway still enforces the real size, but they are enough for a per-user quota or type gate. Before, `params` was empty for both.
