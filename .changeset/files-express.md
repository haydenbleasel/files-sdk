---
"files-sdk": minor
---

Add `files-sdk/express` — `createRouteHandler(router)` returns a Node `(req, res)` handler that bridges `IncomingMessage`/`ServerResponse` to the Web `Request`/`Response` the gateway speaks (also works with Connect and a raw `http.createServer`). A client disconnect aborts the upstream read on a proxied download. Mount it before any body parser so the gateway can read the raw upload/JSON body.
