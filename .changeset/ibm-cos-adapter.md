---
"files-sdk": minor
---

Add IBM Cloud Object Storage adapter at `files-sdk/ibm-cos`, a thin S3 wrapper that derives the endpoint from the region code (`s3.<region>.cloud-object-storage.appdomain.cloud` — `us-south`, `us-east`, `eu-de`, `eu-gb`, `jp-tok`, `au-syd`, `br-sao`, `ca-tor`, …), defaults to virtual-hosted-style addressing, and auto-loads credentials from `IBM_COS_ACCESS_KEY_ID` / `IBM_COS_SECRET_ACCESS_KEY`. Auth uses IBM Cloud's HMAC credentials (tick "Include HMAC Credential" in the service-credential Advanced options), not IAM API keys. For direct (no-egress) access from inside the same IBM Cloud region, pass `https://s3.direct.<region>.cloud-object-storage.appdomain.cloud` as an explicit `endpoint`. Errors are relabelled as `IBM Cloud Object Storage error`.
