---
"files-sdk": minor
---

minio: add the `client: "fetch"` engine (#155). `minio({ client: "fetch" })` runs on the same SigV4-signed `aws4fetch` core as `r2({ client: "fetch" })` and `s3Fetch()` — no `@aws-sdk/*` packages installed or bundled — while keeping MinIO's defaults: path-style addressing, the `us-east-1` signing region, and `MinIO error` labels. Pointing the generic `s3Fetch()` at MinIO dropped those, and the virtual-hosted default then surfaced as a misleading `NotFound: The specified bucket does not exist` (MinIO has no per-bucket DNS, so it reads the key's first folder as the bucket). Inside Cloudflare Workers the fetch engine is now the default, exactly as for `r2()`: the aws-sdk engine's XML parsing needs `DOMParser`, which workerd lacks; an explicit `client: "aws-sdk"` or a `DOMParser` polyfill keeps the SDK engine. A `fetch` option overrides the fetch implementation for tests and instrumented runtimes.

The `"aws-sdk"` engine behind `minio()` is now loaded lazily on first use, so a Worker bundle on the fetch engine never includes `@aws-sdk/client-s3`. One visible consequence: `files.raw` is `undefined` until any method has run — call one first if you read the underlying `S3Client` directly.

s3-fetch: a `NoSuchBucket` error received under virtual-hosted addressing now appends a hint to pass `forcePathStyle: true`, since on services without per-bucket DNS (MinIO, LocalStack, most self-hosted gateways) that error almost always means the bucket landed in the hostname rather than that it is missing.
