---
"files-sdk": minor
---

Add Wasabi adapter at `files-sdk/wasabi`, a thin S3 wrapper that derives the endpoint from the region code (`s3.<region>.wasabisys.com`), defaults to virtual-hosted-style addressing, and auto-loads credentials from `WASABI_ACCESS_KEY_ID` / `WASABI_SECRET_ACCESS_KEY`. Region names mirror AWS but the endpoints are Wasabi's own; errors are relabelled as `Wasabi error`.
