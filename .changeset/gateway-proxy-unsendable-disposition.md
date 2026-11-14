---
"files-sdk": patch
---

When `authorize` returns a `disposition` that can't be sent as a `Content-Disposition` header (a control character, or a raw non-Latin-1 filename), a proxied download through `files-sdk/api` now fails with a `422` that says how to encode the name (`filename*=UTF-8''…`). It used to open the object, fail while building the response, and answer a generic `500` with the storage stream left open.
