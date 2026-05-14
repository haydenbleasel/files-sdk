---
"files-sdk": minor
---

Add OVHcloud Object Storage adapter at `files-sdk/ovhcloud`, a thin S3 wrapper that derives the endpoint from the region code (`s3.<region>.io.cloud.ovh.net` — High Performance S3 tier), defaults to virtual-hosted-style addressing, and auto-loads credentials from `OVH_ACCESS_KEY_ID` / `OVH_SECRET_ACCESS_KEY`. For the Standard (Swift-backed) tier, pass `https://s3.<region>.cloud.ovh.net` as an explicit `endpoint`. Errors are relabelled as `OVHcloud error`.
