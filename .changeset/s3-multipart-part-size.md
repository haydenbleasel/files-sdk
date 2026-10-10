---
"files-sdk": patch
---

`multipart.partSize` on `files-sdk/s3` and the S3-compatible adapters' aws-sdk client is now rounded into what S3 accepts. A size under 5 MiB is raised to S3's minimum instead of failing every attempt with `EntityTooSmall`, a size over 5 GiB is lowered to the maximum, and when the body's length is known the size grows until the body fits in S3's 10,000 parts, instead of failing at part 10,001 after about 48.8 GiB had uploaded.
