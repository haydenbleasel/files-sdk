---
"files-sdk": minor
---

Add iDrive e2 adapter at `files-sdk/idrive-e2`, a thin S3 wrapper that takes an explicit `endpoint` (iDrive e2 hostnames are tied to the provisioned bucket cluster and don't follow a public pattern — copy it from the iDrive e2 dashboard under Access Keys → Endpoint), defaults the SigV4 region to `"us-east-1"`, and auto-loads credentials from `IDRIVE_E2_ACCESS_KEY_ID` / `IDRIVE_E2_SECRET_ACCESS_KEY`. Errors are relabelled as `iDrive e2 error`.
