---
"files-sdk": patch
---

`files-sdk/dedup` now reports the content's SHA-256 hash as the `etag` of `upload()`, `download()`, `head()` and `list()` results. A pointer's own ETag was identical for every key and never changed with the content, so `sync()` in its default `"etag"` mode skipped same-size edits between dedup instances (leaving the destination stale) and `versioning()` ids could collide.
