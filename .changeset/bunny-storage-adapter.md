---
"files-sdk": minor
---

Add Bunny Storage adapter (`files-sdk/bunny-storage`). Wraps the official `@bunny.net/storage-sdk` and connects to a Storage Zone via zone name + access key + region. Auto-loads from `BUNNY_STORAGE_ZONE` / `BUNNY_STORAGE_ACCESS_KEY` / `BUNNY_STORAGE_REGION`, with `STORAGE_*` accepted as aliases (the names used in the Bunny SDK's README). `url()` requires `publicBaseUrl` (typically a Bunny Pull Zone) and returns a permanent CDN URL — Bunny has no signed-read primitive, so `expiresIn` is ignored and `responseContentDisposition` throws. `signedUploadUrl()` throws because Bunny writes require the Storage API `AccessKey` header. `copy()` is a read-then-write (no server-side copy primitive in the SDK). Custom `metadata` and `cacheControl` on upload throw — configure cache behavior on the Pull Zone instead.
