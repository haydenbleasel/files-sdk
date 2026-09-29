---
"files-sdk": patch
---

The `files-sdk/api` gateway and `files-sdk/signed-url-policy` no longer accept a requested `attachment` disposition that contains control characters. Previously any value starting with `attachment` was kept as "already safe", so a caller could send `attachment\r\n…` and have it ride into the signed URL's `response-content-disposition`. Such values are now replaced with the configured default disposition, like `inline` is. A tab (`\t`) is still allowed.
