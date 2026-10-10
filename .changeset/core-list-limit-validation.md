---
"files-sdk": patch
---

`list()`, `listAll()`, and `search()` in `files-sdk` now reject a `limit` that isn't a positive integer, and `search()` a negative, fractional, or `NaN` `maxResults`, with an `Invalid` error before any provider call. Before, `limit: -1` made the `fs`, memory, FTP, and SFTP adapters silently drop the last key of each page, `0` or `NaN` walked nothing, and a bad `maxResults` returned nothing or everything. `maxResults: 0` still yields no matches.
