---
"files-sdk": patch
---

Range downloads on `files-sdk/bun-s3` work on real Bun again. Bun's `S3Stats` exposes its fields as getters, so spreading it copied nothing, `lastModified` came back `undefined`, and every ranged `download()` failed. The adapter now copies each field explicitly.
