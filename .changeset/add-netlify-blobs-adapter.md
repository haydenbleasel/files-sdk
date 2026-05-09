---
"files-sdk": minor
---

Add Netlify Blobs adapter (`files-sdk/netlify-blobs`). Wraps the `@netlify/blobs` SDK with site-scoped or deploy-scoped stores, configurable consistency, and a metadata round-trip that packs `contentType`/`size`/`lastModified`/`cacheControl` plus user metadata into Netlify's metadata map so `head()`/`download()` return rich fields. Auto-detects credentials from Netlify's runtime context (`NETLIFY_BLOBS_CONTEXT`) when available, with explicit `siteID`/`token` overrides falling back to `NETLIFY_SITE_ID` / `NETLIFY_API_TOKEN` / `NETLIFY_BLOBS_TOKEN`. `copy()` is read-then-write since Netlify has no native copy primitive; `list()` returns key + etag (rich metadata requires a per-item `head()`); `url()` and `signedUploadUrl()` throw because Netlify Blobs has no public URL or presigned-upload primitive.
