---
"files-sdk": patch
---

The UploadThing adapter (`files-sdk/uploadthing`) now rejects an `expiresIn` over UploadThing's 7-day limit with `Invalid` before signing. This applies to `url()` and to the signed fetch URL that a too-long `defaultUrlExpiresIn` would produce on a private download. Before, UploadThing's own plain `Error` was mapped to a retryable `Provider` error. A failure to mint a private file's signed URL during `download()` or `head()` is now mapped through the adapter's error classifier too, so a 403 there is `Unauthorized`. A failed direct CDN read in `head()` or `download()` now maps its HTTP status to the standard error codes (401/403 → `Unauthorized`, 409/412 → `Conflict`, 404/410 → `NotFound`) instead of treating every status except 404 as `Provider`.
