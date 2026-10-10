---
"files-sdk": patch
---

`files-sdk/events`: SNS signature verification now accepts a `SigningCertURL` only at `https://sns.<region>.amazonaws.com/SimpleNotificationService-<id>.pem` (or `.amazonaws.com.cn`). The previous host check also matched S3 bucket endpoints such as `sns.s3-accelerate.amazonaws.com`, so a bucket named `sns` could have served a certificate.
