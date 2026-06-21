---
"files-sdk": minor
---

Add `files-sdk/astro` — `createRouteHandler(router)` returns `{ GET, POST, PUT }` for an Astro endpoint (`GET` serves downloads, `POST` the JSON verbs, `PUT` the upload byte path). The handlers are Web-native, so the route runs on Node and edge adapters alike. The endpoint must run per-request: set `prerender = false` (or `output: "server"`) with an SSR adapter.
