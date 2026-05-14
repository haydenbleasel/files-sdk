---
"files-sdk": minor
---

Add Tigris adapter at `files-sdk/tigris`, a thin S3 wrapper around Tigris's globally-distributed object storage. Uses the fixed `https://fly.storage.tigris.dev` endpoint with virtual-hosted-style addressing, defaults the SigV4 region to `"auto"` since Tigris doesn't route by region, and auto-loads credentials from `TIGRIS_ACCESS_KEY_ID` / `TIGRIS_SECRET_ACCESS_KEY`. Errors are relabelled as `Tigris error`.
