---
"files-sdk": patch
---

`files-sdk/supabase` now recognizes a missing object. Supabase Storage answers with HTTP 400 and puts the real status in the body (`statusCode: "404"`, `code: "NoSuchKey"`), which used to map to a `Provider` error, so `exists()` threw instead of returning `false` and `head()`/`download()` never raised `NotFound`. The body status and code now take priority, and a malformed-key `InvalidKey` error is no longer reported as `Unauthorized`.
