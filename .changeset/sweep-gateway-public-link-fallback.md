---
"files-sdk": patch
---

A `download` on the `files-sdk/api` gateway in the default `"auto"` mode now falls back to proxying the bytes when the adapter or a plugin refuses the redirect URL with an `Unsupported` error, on the public-link path as well as the signed one. Before, a refusal of the permanent public link (for example `signedUrlPolicy()` insisting on a disposition Vercel Blob's public URLs can't carry) surfaced as an error even though the proxy could serve the file. `"redirect"` mode still surfaces the refusal.
