---
"files-sdk": patch
---

The Node gateway bindings (`files-sdk/express`, `files-sdk/koa`, `files-sdk/fastify`, `files-sdk/nitro`, `files-sdk/nestjs` and the raw `node:http` handler) no longer let the request target choose the request's host. A path such as `//evil.example/api/files` or an absolute-form target resolved to that host, so on a catch-all mount a cross-site page on it passed the default same-origin check for mutations. The origin now always comes from the `Host` header.
