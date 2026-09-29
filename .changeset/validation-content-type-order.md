---
"files-sdk": patch
---

The `files-sdk/validation` and `files-sdk/content-type` docs now spell out plugin order. `contentType()` must come before `validation()` in the `plugins` array: in the reverse order `validation()` approves the type the client claimed (say `image/png` from `avatar.png`) and `contentType()` then relabels the upload from its bytes (to `text/html`), slipping past `allowedTypes`. `validation()` must also come before `versioning()`, `softDelete()` and `dedup()`, whose internal writes (`.versions/…`, `.trash/…`, `.dedup/…`, empty pointer bodies) would otherwise be rejected by `key` or `minSize` rules.
