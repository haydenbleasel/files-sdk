---
"files-sdk": patch
---

`contentType()` (`files-sdk/content-type`) now stores the type it confirmed. When the bytes agree with the type the key's extension implies, that type is forwarded to the adapter, so a `photo.png` of real PNG bytes is stored as `image/png` rather than the adapter's default (`application/octet-stream`), matching how a mismatched upload was already relabeled. Bodies it can't identify still keep an explicit or `Blob` type and otherwise the adapter's default; the key's extension alone is never stored.
