---
"files-sdk": patch
---

A `search` through the `files-sdk/api` gateway now always walks storage in pages of `maxListLimit` keys. The client's `limit` was used as the page size while `maxSearchScan` counts keys, so `limit: 1` turned one request into up to 10,000 provider `list()` calls; `limit` is now ignored by the gateway, and `maxResults` still caps the matches.
