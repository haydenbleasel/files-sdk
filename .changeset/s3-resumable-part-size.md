---
"files-sdk": patch
---

Resumable (`control`) uploads on `files-sdk/s3` and its S3-compatible wrappers now grow the part size to fit the body in S3's 10,000-part limit, up to the 5 GiB part maximum. At the 5 MiB default, bodies over about 48.8 GiB needed more than 10,000 parts, and S3 rejected part 10,001 after everything before it had uploaded. The chosen part size is pinned in the resume token.
