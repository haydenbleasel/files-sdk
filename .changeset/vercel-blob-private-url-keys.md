---
"files-sdk": patch
---

Refuse private `url()` in the Vercel Blob adapter (`files-sdk/vercel-blob`) for keys a presigned URL can't carry, with an `Unsupported` error before any token is issued. `@vercel/blob` puts the key into the presigned `GET` URL unencoded, so a `#`, `?`, `%`, `\`, a `.` or `..` path segment, or a trailing space produced a link to a different path than the one signed (`reports/Invoice #42.pdf` became a link to `reports/Invoice `), and a key starting with `http://` or `https://` produced a signed link to that other host. `download()` reads those blobs correctly, and a gateway in `auto` download mode proxies them instead of redirecting. Public stores are unaffected: their URLs encode the key.
