---
"files-sdk": minor
---

Add Alibaba Cloud Object Storage Service (OSS) adapter (`files-sdk/alibaba`). Thin wrapper around the S3 adapter — endpoint derived from the region code (`oss-<region>.aliyuncs.com`), virtual-hosted-style addressing, errors relabelled as "Alibaba Cloud error". Auto-loads from `ALIBABA_ACCESS_KEY_ID` and `ALIBABA_ACCESS_KEY_SECRET`.
