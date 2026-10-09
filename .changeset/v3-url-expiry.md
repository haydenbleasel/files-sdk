---
"files-sdk": major
---

`url(key, { expiresIn })` now always means "give me a link that expires", instead of sometimes returning a permanent link that silently ignored the request.

- **Adapters that can sign:** S3 and the S3-compatible adapters, R2, GCS, Firebase, Azure, Supabase, and Bun's S3 now return a signed URL for an explicit `expiresIn` even when a `publicBaseUrl` is configured, the same way `responseContentDisposition` already did. A plain `url(key)` still returns the permanent CDN link.
- **Adapters that only have permanent links:** Vercel Blob in public mode, UploadThing `public-read`, Convex, Appwrite, the filesystem, and OneDrive / Google Drive in public-link mode now throw an `Unsupported` `FilesError` for an explicit `expiresIn`, before the adapter is called. Before, they returned the permanent link. Leave `expiresIn` out to get that link.
- **Provider-set lifetimes:** Box, PocketBase, and Dropbox's tokenized links keep a lifetime set by the provider (`signedUrl.expiry: "provider"`). Box and Dropbox in their public-link modes (`publicBaseUrl` / `publicByDefault`) now return that tokenized link for an explicit `expiresIn`, instead of the permanent share link.
- **Two new capabilities:**
  - `files.capabilities.publicUrl` reports whether a plain `url(key)` returns a permanent link on this instance.
  - `files.capabilities.signedUrl.disposition` reports whether a `responseContentDisposition` is bound into the signed URL.
  - Custom adapters declare both in their `capabilities` (they default to `false`).
- **Gateway downloads (`files-sdk/api`):** a download now redirects to a signed URL only when the adapter can also bind the forced `Content-Disposition`, and otherwise streams through the proxy. This fixes default gateway downloads failing on adapters that sign but reject a disposition: Vercel Blob and UploadThing in private mode, PocketBase, and Cloudinary private delivery. With no forced disposition and no `authorize` lifetime cap, an adapter with a permanent public link is redirected to it.
- **Gateway `url` operation:** it signs whenever the adapter can. On an adapter that can't sign, a client-requested `expiresIn` or an `authorize` `maxExpiresIn` is answered with a `422` instead of a permanent link.
- **`signedUrlPolicy()`:** it no longer pins a missing `expiresIn` on an instance that can't sign, which would now throw.
