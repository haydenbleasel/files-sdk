---
"files-sdk": patch
---

`files-sdk/netlify-blobs` `list()` now returns a `cursor` when `limit` leaves entries unreturned and resumes from it, so `listAll({ limit })` and paginated file browsers see every key instead of silently stopping after the first page. The cursor is the last key of the page (Netlify's own cursor is internal to its SDK), and with `delimiter` a folder counts against `limit` like a file, matching the other key-list adapters.
