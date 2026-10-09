---
"files-sdk": patch
---

The filesystem adapter (`files-sdk/fs`) now declares `capabilities.publicUrl` only when it is built with `urlBaseUrl`. Without one, `url(key)` returns a `file://` path on the server, which no browser can open. A `files-sdk/api` gateway used to redirect downloads to that path when `authorize` returned `{ disposition: "inline" }` or `forceDownloadDisposition` was `false`, which broke the download and leaked the server's absolute path. Those downloads now stream through the gateway proxy. `url(key)` itself is unchanged.
