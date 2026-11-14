---
"files-sdk": patch
---

The `files-sdk/api` gateway's `presign` now answers `422` for an `expiresIn` that isn't a positive whole number of seconds. `0` or a negative value used to return an upload token that had already expired, and on a signing adapter any such value silently switched the upload to the gateway's proxy.
