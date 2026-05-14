---
"files-sdk": minor
---

Add Backblaze B2 adapter at `files-sdk/backblaze-b2`, a thin S3 wrapper that derives the endpoint from the cluster code (`s3.<region>.backblazeb2.com`), defaults to virtual-hosted-style addressing, and auto-loads credentials from `B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY`. Errors are relabelled as `Backblaze B2 error` and `publicBaseUrl` accepts B2's friendly download URL prefix for skipping signing on public buckets.
