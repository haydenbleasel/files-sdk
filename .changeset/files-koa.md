---
"files-sdk": minor
---

Add `files-sdk/koa` — `createRouteHandler(router)` returns a Koa handler that sets `ctx.respond = false` and bridges `ctx.req`/`ctx.res` to the Web `Request`/`Response` the gateway speaks (the same seam as `files-sdk/express`). A client disconnect aborts the upstream read on a proxied download. Mount it before any body parser so the gateway can read the raw upload/JSON body.
