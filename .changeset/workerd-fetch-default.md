---
"files-sdk": patch
---

r2: default to the `"fetch"` client inside Cloudflare Workers. The `"aws-sdk"` client's XML parsing needs a `DOMParser`, which workerd doesn't provide, so it failed at runtime on the first list or error-body parse. Detection is `navigator.userAgent === "Cloudflare-Workers"` (or the workerd-only `WebSocketPair` global when `navigator` is disabled); an explicit `client: "aws-sdk"` or a `DOMParser` polyfill on the global keeps the aws-sdk engine.

A Worker that had the aws-sdk client working now gets the fetch engine's narrower surface unless it opts back in: `multipart` and resumable `control` uploads throw, `ReadableStream` bodies are buffered before a single PUT, bulk deletes fan out per key instead of one `DeleteObjects`, keys with `.`/`..` segments are rejected, `signedUploadUrl({ maxSize })` throws, and `files.raw` is an aws4fetch `AwsClient` rather than an `S3Client`.

New `files-sdk/s3-fetch` subpath: `s3Fetch()` exposes the same SigV4 fetch engine for any S3-compatible endpoint (AWS S3, MinIO, Tigris, ...) on runtimes where `files-sdk/s3` can't run. Static credentials with `AWS_*` env fallbacks, `forcePathStyle` for services without per-bucket DNS, no `@aws-sdk/*` peers.
