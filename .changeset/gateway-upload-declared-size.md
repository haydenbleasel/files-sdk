---
"files-sdk": patch
---

A keyless upload through the `files-sdk/api` gateway is now held to the size the client declared at `presign`, capped by `maxUploadSize`. Before, `authorize` saw the declared size but the upload token allowed anything up to `maxUploadSize`, so a client could understate the size to pass a per-user quota. The proxy `PUT` and `complete` now refuse a larger body, a storage-signed target binds the declared size where the adapter can, and a client that doesn't know a file's size may omit `size` (that upload is held to `maxUploadSize` alone). A declared size that isn't a non-negative whole number is a `422`.
