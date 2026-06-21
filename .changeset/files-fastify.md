---
"files-sdk": minor
---

Add `files-sdk/fastify` — `createRouteHandler(router)` returns a Fastify `(request, reply)` handler that `reply.hijack()`s and bridges the raw `IncomingMessage`/`ServerResponse` to the Web `Request`/`Response` the gateway speaks (the same seam as `files-sdk/express`). A client disconnect aborts the upstream read on a proxied download. Drop Fastify's built-in body parsers (`removeAllContentTypeParsers()` + a no-op `addContentTypeParser("*", …)`) so the gateway can read the raw upload/JSON body.
