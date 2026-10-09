---
"files-sdk": patch
---

S3 family fixes:

- Presigned PUT URLs on AWS no longer carry an empty-body checksum (`x-amz-checksum-crc32=AAAAAA==`) that made S3 reject every real upload.
- Metadata that can't travel as a header (non-Latin-1 or control characters) and out-of-order resumable calls are `Invalid` instead of a retried `Provider` error.
- Presigned POST uploads enforce the 7-day expiry limit.
- An explicit `amazonaws.com` endpoint (or `AWS_ENDPOINT_URL*`) counts as AWS for events and conditional writes on both engines.
- Backblaze B2 refuses `maxSize` up front, since it has no presigned POST.
- Bun S3 reports a 401/403 on HEAD as `Unauthorized` instead of retrying it.
