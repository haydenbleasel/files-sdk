---
"files-sdk": minor
---

Add Vultr Object Storage adapter at `files-sdk/vultr`, a thin S3 wrapper that derives the endpoint from the region code (`<region>.vultrobjects.com` — `ewr`, `sjc`, `ams`, `blr`, `del`, `sgp`, `lux`), defaults to virtual-hosted-style addressing, and auto-loads credentials from `VULTR_ACCESS_KEY_ID` / `VULTR_SECRET_ACCESS_KEY`. Errors are relabelled as `Vultr error`.
