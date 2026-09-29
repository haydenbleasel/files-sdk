---
"files-sdk": patch
---

`signedUploadUrl({ contentType })` on `files-sdk/bun-s3` now rejects. Bun's presigned PUT URLs sign only the `host` header (its `type` option becomes a `response-content-type` query parameter), so the Content-Type was never enforced and the returned header was advisory. Omit `contentType`, or use `files-sdk/s3` or `files-sdk/s3-fetch`, which sign it. The `useFiles` gateway falls back to proxying such uploads through your server.
