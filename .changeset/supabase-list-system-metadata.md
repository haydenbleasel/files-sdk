---
"files-sdk": patch
---

Fixed the Supabase adapter's `list()` reporting Supabase's system metadata block (eTag, size, mimetype, cacheControl, contentLength, lastModified) as user `metadata` on every item, which `head()` and `download()` never reported. List items now only surface user metadata when the listing response carries it under `user_metadata`.
