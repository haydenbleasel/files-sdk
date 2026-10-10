---
"files-sdk": patch
---

`files-sdk/supabase` now percent-encodes keys in every request URL. Keys went into the path unencoded, so a `#` or `?` cut the key short: `upload("uploads/Invoice #42.pdf")` stored `uploads/Invoice `, a later `#43` upload silently overwrote it, and `head`, `download` and `delete` disagreed about which object the key named. Uploads, downloads, `head`, `exists`, `url()` (signed and public) and `signedUploadUrl()` now address exactly the key given, including keys with `?`, `%`, spaces or `+`. Keys that Supabase Storage itself refuses (such as ones containing `#` or non-ASCII characters) now fail with Supabase's `Invalid key` error instead of being truncated.
