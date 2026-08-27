---
"files-sdk": patch
---

Fixed the CLI silently dropping the `--endpoint` flag for `--provider r2`, so jurisdiction-specific buckets and S3-compatible stand-ins can now be targeted without an account id.
