---
"files-sdk": patch
---

`files-sdk/vercel-blob` downloads no longer return stale bytes right after an overwrite. The body came through the CDN cache while the size and ETag came from a fresh `head()`, so for up to a minute the old content was returned labelled with the new metadata. Private downloads now read from origin (`useCache: false`), and public downloads add a `v=<etag>` query parameter to the blob URL so each new version misses the cache once.
