---
"files-sdk": patch
---

Lazy-load the Vercel Blob peer dependency from the `files-sdk/vercel-blob` adapter so importing the adapter no longer resolves `@vercel/blob` until an operation uses it.
