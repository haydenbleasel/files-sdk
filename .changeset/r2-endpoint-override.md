---
"files-sdk": patch
---

Add an optional `endpoint` to the r2 adapter (`R2HttpOptions` and hybrid-mode `R2BindingOptions`), falling back to the default `https://<accountId>.r2.cloudflarestorage.com`. Jurisdiction buckets (`eu`, `fedramp`) live on their own hostnames and were previously unreachable through the r2 adapter; the override also lets tests point the adapter at S3-compatible stand-ins like MinIO or LocalStack.
