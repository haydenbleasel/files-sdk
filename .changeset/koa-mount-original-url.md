---
"files-sdk": patch
---

`files-sdk/koa` now passes the gateway the pre-mount URL (`ctx.originalUrl`). Under `koa-mount`, `ctx.req.url` has the mount prefix stripped, so the proxy-upload target the gateway builds pointed at the wrong path.
