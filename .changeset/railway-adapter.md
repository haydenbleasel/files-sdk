---
"files-sdk": patch
---

Add a Railway Buckets adapter (`files-sdk/railway`). Railway Buckets are private, Tigris-backed, S3-compatible storage, and `railway()` wraps the `s3()` adapter with Railway's defaults: the `https://t3.storageapi.dev` endpoint, the `"auto"` signing region, and `"Railway Buckets error"` provider labels. It reads the variables `railway bucket credentials` prints (`AWS_S3_BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL`, and `AWS_S3_URL_STYLE`, which switches older buckets to path-style addressing), so it takes no options once a service has them. Credentials never fall back to the AWS credential chain, so a shared AWS profile or instance role can't sign Railway requests. Railway buckets have no public URLs, so `url()` presigns unless `publicBaseUrl` points at a proxy in front of the bucket. Available to the CLI and MCP server as `--provider railway`.
