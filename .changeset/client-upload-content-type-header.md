---
"files-sdk": patch
---

A global `Content-Type` in the `headers` option of `files-sdk/client` (and the `useFiles` bindings) no longer overrides the type of keyed uploads. It used to replace every `upload(key, body)` request's type, even an explicit `contentType`, so files were stored as, say, `application/json`. The body's own type or `contentType` now always wins, and the JSON verbs always send `application/json`.
