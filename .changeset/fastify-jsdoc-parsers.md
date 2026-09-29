---
"files-sdk": patch
---

`files-sdk/fastify` JSDoc example now calls `app.removeAllContentTypeParsers()` before adding the catch-all parser, matching the docs. Fastify's built-in `application/json` and `text/plain` parsers take precedence over `*` and would otherwise consume the body the gateway needs.
