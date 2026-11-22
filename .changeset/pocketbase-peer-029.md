---
"files-sdk": patch
---

Accept `pocketbase` 0.29 as a peer of the PocketBase adapter (`files-sdk/pocketbase`). The record and file APIs the adapter uses are unchanged. The SDK now clears its auth store when a request answers `401`: with credentials the adapter manages, the next call logs in again rather than failing until the token expires locally; with your own `client`, a `401` on an adapter request signs that shared client out too (call `client.autoClearAuthStore(false)` to opt out).
