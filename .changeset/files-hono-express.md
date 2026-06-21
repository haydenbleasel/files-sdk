---
"files-sdk": minor
---

Add Hono and Express bindings for the gateway, plus framework adapter docs.

- `files-sdk/hono` — `createRouteHandler(router)` returns a single Hono handler (`app.all("/api/files", handler)`). Web-native, so it runs on Workers, Bun, Deno, and Node.
- `files-sdk/express` — `createRouteHandler(router)` returns a Node `(req, res)` handler that bridges `IncomingMessage`/`ServerResponse` to the Web `Request`/`Response` the gateway speaks (also works with Connect and a raw `http.createServer`). A client disconnect aborts the upstream read on a proxied download. Mount it before any body parser so the gateway can read the raw upload/JSON body.
- Docs: per-framework mounting guides (Next.js, Hono, Express) under the restructured `/ui` section.
