---
"files-sdk": minor
---

Add Tencent Cloud Object Storage (COS) adapter (`files-sdk/tencent`). Thin wrapper around the S3 adapter — endpoint derived from the region code (`cos.<region>.myqcloud.com`), virtual-hosted-style addressing, errors relabelled as "Tencent Cloud error". Auto-loads from `TENCENT_SECRET_ID` and `TENCENT_SECRET_KEY`. Bucket name must include the `-<appid>` suffix per COS's namespacing.
