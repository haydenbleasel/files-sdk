---
"files-sdk": patch
---

Fix private downloads in the Vercel Blob adapter (`files-sdk/vercel-blob`) for keys containing `#`, `?`, or `%`. `download()` handed the raw key to `@vercel/blob`'s `get()`, which builds the blob URL by plain concatenation, so a `#` or `?` ended the path there and a `%xx` sequence was decoded: `reports/Invoice #42.pdf` read whatever blob sat at `reports/Invoice ` (or failed with `NotFound`), while `head()` still reported the right blob's metadata. The download now reads the blob's own URL, the one `head()` returns, as public downloads already do. Keys with only spaces or non-ASCII characters were not affected, and public stores never were.
