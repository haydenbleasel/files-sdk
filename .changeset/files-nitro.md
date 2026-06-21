---
"files-sdk": minor
---

Add `files-sdk/nitro` — `createRouteHandler(router)` returns an h3 event handler for Nitro (and Nuxt server) routes that marshals `event.node.req` into the Web `Request` the gateway speaks and returns the Web `Response` for Nitro to flush, hiding the `toWebRequest(event)` step. A client disconnect aborts the upstream read on a proxied download. Targets Nitro v2 / h3 v1, where `event.node.req` is present on every preset.
