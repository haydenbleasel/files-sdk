---
"files-sdk": minor
---

Add Scaleway Object Storage adapter at `files-sdk/scaleway`, a thin S3 wrapper that derives the endpoint from the region code (`s3.<region>.scw.cloud` — `fr-par`, `nl-ams`, `pl-waw`), defaults to virtual-hosted-style addressing, and auto-loads credentials from `SCW_ACCESS_KEY` / `SCW_SECRET_KEY`. Errors are relabelled as `Scaleway error`.
