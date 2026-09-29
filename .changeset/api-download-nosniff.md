---
"files-sdk": patch
---

`files-sdk/api` proxied downloads now send `X-Content-Type-Options: nosniff`, so a browser won't sniff stored bytes into an executable type when a download is served inline.
