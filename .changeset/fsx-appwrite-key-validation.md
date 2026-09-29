---
"files-sdk": patch
---

`files-sdk/appwrite` now rejects keys that aren't valid Appwrite file IDs on every method (`download`, `head`, `exists`, `delete`, `url`, and the `copy` source), not only on writes. Previously a key such as `..` or `.` reached node-appwrite, which leaves dots unencoded, so URL normalization pointed the request at the bucket instead of a file: `delete("..")` sent `DELETE /storage/buckets/{bucketId}`.
