---
"files-sdk": patch
---

The Cloudinary adapter (`files-sdk/cloudinary`) now reports only what it can actually do without an API secret. For `private` and `authenticated` delivery types, `files.capabilities.signedUrl.supported` used to be `true` even when no API key and secret had been resolved. In that case `url()` and `download()` failed on every call with a retried `Provider` error ("Must supply api_secret"). The capability now needs both credentials: the adapter's own, or ones a pre-built `client` was configured with. Without them, `url()` and `download()` throw `Unsupported` before making any request. When the adapter has its own key and secret, it now signs `private_download_url` with them explicitly, so a different global `cloudinary.config()` no longer changes what a URL is signed with.

The `resumableUpload` driver is likewise only attached when both `apiKey` and `apiSecret` are resolved, so `files.capabilities.resumable` is `false` without them. A signed read of a raw asset with no stored format is now `Unsupported` instead of `Provider`. A failed CDN read now maps its HTTP status to the standard error codes (401/403 → `Unauthorized`, 409/412 → `Conflict`, 404/410 → `NotFound`) instead of treating every status except 404 as a retryable `Provider` error.
