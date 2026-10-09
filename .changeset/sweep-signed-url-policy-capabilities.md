---
"files-sdk": patch
---

`files-sdk/signed-url-policy` now narrows `files.capabilities` to what still works under the policy, so the `files-sdk/api` gateway and callers that branch on capabilities proxy instead of planning a call that always throws:

- With `maxUploadSize` on an adapter that can't enforce `maxSize` in a signed upload (R2, Azure, Supabase, the `fetch` S3 client, Bun S3, …), `signedUpload.supported` is now `false`. Every `signedUploadUrl()` there already threw.
- With the forced disposition (the default), `publicUrl` is now `false`: every `url()` carries a disposition, which a permanent link can't bind (on Vercel Blob in public mode, Convex, or the filesystem, every `url()` already threw). On an adapter that signs but can't bind a disposition (Vercel Blob in private mode), `signedUrl.supported` is now `false` as well, and a `url(key, { expiresIn })` there is refused before the adapter with an `Unsupported` error naming the plugin.
- With `maxExpiresIn` on an instance that signs, `publicUrl` is now `false`, because a plain `url()` is pinned to the cap and signed.
