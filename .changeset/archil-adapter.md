---
"files-sdk": minor
---

Add an Archil adapter (`files-sdk/archil`) for [Archil](https://archil.com) disks over their S3-compatible API. The disk id is the path-style bucket and the endpoint is derived from the Archil region; SigV4 enables byte ranges, multipart, and presigned URLs. Supports a `branch` option (branch-scoped access) and an optional `disk` instance exposed at `adapter.disk` for Archil-native operations.
