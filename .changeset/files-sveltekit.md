---
"files-sdk": minor
---

Add `files-sdk/sveltekit` — `createRouteHandler(router)` returns `{ GET, POST, PUT }` for a SvelteKit `+server.ts` endpoint (`GET` serves downloads, `POST` the JSON verbs, `PUT` the upload byte path). The handlers are Web-native, so the route runs on the Node and edge adapters alike. This is the server binding, distinct from the `files-sdk/svelte` client store.
