---
"files-sdk": patch
---

The Node gateway bindings (`files-sdk/express`, `files-sdk/fastify`, `files-sdk/koa`, `files-sdk/nitro`, and `files-sdk/nestjs`) now work over HTTP/2. Under Fastify's `http2: true` or `node:http2`'s compatibility API every request failed with a `500`, because the HTTP/2 pseudo-headers (`:method`, `:path`, `:authority`, `:scheme`) were copied into the Web `Request`; they are now skipped, and the host is taken from `:authority` when there is no `Host` header.
