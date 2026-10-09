---
"files-sdk": patch
---

Treat an explicit AWS endpoint as AWS on the S3 adapter (`files-sdk/s3`). `s3({ endpoint: "https://s3.us-east-1.amazonaws.com" })` (or a VPC, FIPS, dual-stack, GovCloud, or China-region endpoint, or an `AWS_ENDPOINT_URL_S3` / `AWS_ENDPOINT_URL` redirect to one) reported `capabilities.events: false` and no native conditional operations, as if it were an S3-compatible service, while `s3Fetch()` with the same endpoint reported `{ format: "s3" }`. Both engines now share one test: an endpoint whose hostname is `amazonaws.com` or `amazonaws.com.cn` (or a subdomain of either) is AWS, so it declares S3 event records and, unless `conditional: false` is passed, the `If-Match` / `If-None-Match` primitives. Any other endpoint stays fail-closed as before.
