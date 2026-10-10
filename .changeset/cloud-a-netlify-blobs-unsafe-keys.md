---
"files-sdk": patch
---

`files-sdk/netlify-blobs` now rejects keys that `@netlify/blobs` can't address, with an `Invalid` error before any request. The SDK puts keys into request URLs unencoded, so `upload("Invoice #42.pdf")` stored `Invoice `, a `?` cut the key short in the same way, a `\` became `/`, tabs, newlines and trailing spaces were dropped, and `..` segments could even reach another store. Keys containing `#`, `?`, `%`, `\`, tabs or newlines, ending in a space or control character, or with `.` / `..` segments now throw instead of silently naming a different blob.
