---
"files-sdk": patch
---

`cache()` (`files-sdk/cache`) now caps a cached `url()` at the lifetime the URL itself states (`X-Amz-Expires` on S3 and S3-compatible adapters, `X-Goog-Expires` on GCS) when that is shorter than the requested `expiresIn`. Before, a `signedUrlPolicy({ maxExpiresIn: 60 })` placed after `cache()` could leave a 60-second URL cached for up to an hour. The `files-sdk/cache` and `files-sdk/signed-url-policy` docs now say to place `signedUrlPolicy()` before `cache()`, and the `cache()` docs list the `defaultUrlExpiresIn` option.
