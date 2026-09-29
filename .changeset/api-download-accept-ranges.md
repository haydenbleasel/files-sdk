---
"files-sdk": patch
---

`files-sdk/api` proxied downloads now send `Accept-Ranges: none` when the adapter can't serve byte ranges, instead of always advertising `bytes`.
