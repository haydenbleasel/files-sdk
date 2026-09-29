---
"files-sdk": patch
---

The `files-sdk/ovhcloud` `region` and `endpoint` JSDoc now matches OVHcloud's endpoint list. Sydney is `ap-southeast-syd` (not `syd`), and the default `s3.<region>.io.cloud.ovh.net` host is OVHcloud's main endpoint, which serves every storage class and stores objects as Standard by default. It was described as the High Performance endpoint, with `s3.<region>.cloud.ovh.net` as Standard. The legacy `perf` endpoint and the Swift-backed endpoint are now described as opt-in overrides.
