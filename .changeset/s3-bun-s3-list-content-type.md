---
"files-sdk": patch
---

`files-sdk/bun-s3` now infers each `list()` item's `type` from its key, as `files-sdk/s3` and `files-sdk/s3-fetch` already do. An S3 list response carries no `Content-Type`, and this adapter labelled every item `application/octet-stream`, so a `.csv` or `.png` listed as a binary blob. Keys with an unknown extension still fall back to `application/octet-stream`.
