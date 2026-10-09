---
"files-sdk": patch
---

Fix user metadata not round-tripping through the Supabase adapter (`files-sdk/supabase`). Buffered `download()` never returned `metadata`, `etag`, or `lastModified`, because it only asked for the object's info when the response had no Content-Type, and Supabase always sends one. `head()` and streamed downloads did return metadata, but storage-js's `info()` camelCases every key in the response, including user metadata, so `fsenc_dek_iv` came back as `fsencDekIv`. That broke the `encryption()`, `compression()`, and `dedup()` plugins: an encrypted object downloaded as ciphertext with no error. The adapter now calls Supabase's object-info endpoint directly, through the client's own URL, headers, and fetch, so keys come back exactly as they were stored. It does this on every download path, alongside the body request. If that lookup fails with anything other than NotFound, the download now throws instead of returning the body without its metadata.

A Supabase adapter built from a pre-built `client` no longer has a `resumableUpload` driver, since it couldn't reach the TUS endpoint and every resumable upload threw. `files.capabilities.resumable` is now `false` for it, and `upload({ control })` is refused up front with the core `Unsupported` error.
